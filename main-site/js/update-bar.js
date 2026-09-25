// Update prompt bar (update-bar-spec.md). A new worker never activates on its
// own: this notices one waiting, says so, and promotes it only when somebody
// presses Reload.

const SW_URL = "/sw.js";

const STRINGS = {
  label: "Update",
  ready: "A new version of 2048 Game is ready.",
  reload: "Reload",
  later: "Not now",
};

// A game tab can stay open for days without navigating, and the browser only
// looks for a new worker on navigation. Ask on the way back to the tab instead,
// at most this often.
const UPDATE_CHECK_EVERY_MS = 30 * 60 * 1000;

let registration = null;
let waitingWorker = null;
let reloading = false;
let dismissed = false;
let lastCheck = 0;

function buildBar() {
  const bar = document.createElement("div");
  bar.className = "update-notice hidden";
  bar.setAttribute("role", "status");
  bar.setAttribute("aria-label", STRINGS.label);
  // Constant strings only, so no escaping is needed here.
  bar.innerHTML = `
    <div class="update-notice-clip">
      <div class="update-notice-inner">
        <p>${STRINGS.ready}</p>
        <button type="button" class="btn btn-primary" data-sw-update>${STRINGS.reload}</button>
        <button type="button" class="btn btn-quiet" data-sw-later>${STRINGS.later}</button>
      </div>
    </div>
  `;

  bar.querySelector("[data-sw-update]").addEventListener("click", (e) => {
    // The only place anything asks for skipWaiting. The reload happens on
    // controllerchange, not here.
    e.currentTarget.disabled = true;
    waitingWorker?.postMessage("skip-waiting");
  });

  bar.querySelector("[data-sw-later]").addEventListener("click", () => {
    // This page view only, never stored.
    dismissed = true;
    render();
  });

  return bar;
}

// The bar is built once and then shown or hidden with .hidden, so both ways
// animate like everything else in the theme.
function render() {
  const show = Boolean(waitingWorker) && !dismissed;
  let bar = document.querySelector(".update-notice");

  if (!bar) {
    if (!show) return;
    bar = buildBar();
    document.body.prepend(bar);
    bar.getBoundingClientRect(); // commit the hidden state so the reveal animates
  }

  bar.classList.toggle("hidden", !show);
}

function watchForUpdate() {
  if (!registration) return;

  // A worker already waiting when the page opened: the usual case on the
  // next visit after a deploy.
  if (registration.waiting && navigator.serviceWorker.controller) {
    waitingWorker = registration.waiting;
    render();
  }

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;

    installing.addEventListener("statechange", () => {
      // "installed" with no controller is a first install, with no previous
      // version on screen to protect, so nothing to prompt about.
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting ?? installing;
        render();
      }
    });
  });
}

function checkForUpdate() {
  if (!registration || document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now - lastCheck < UPDATE_CHECK_EVERY_MS) return;
  lastCheck = now;
  registration.update().catch(() => {
    // Offline, most likely. The next visit to the tab tries again.
  });
}

function registerWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker
    .register(SW_URL)
    .then((reg) => {
      registration = reg;
      lastCheck = Date.now();
      watchForUpdate();
    })
    .catch((cause) => {
      // Not a reason to break the page: private browsing in some browsers,
      // and any http origin that is not localhost, land here.
      console.warn("service worker registration failed:", cause);
    });

  // Reload once the new worker has taken over, so the page comes back on the
  // new version. The flag stops a second controllerchange looping it.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  document.addEventListener("visibilitychange", checkForUpdate);
}

export function initUpdateBar() {
  // After load, so precaching does not compete with the page's own first fetches.
  if (document.readyState === "complete") registerWorker();
  else window.addEventListener("load", registerWorker, { once: true });
}
