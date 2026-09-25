// Page wiring: the theme modal (uwuapps-theme.md, section 6), settings, the
// leaderboards, the update bar and the game (js/game.js).

import { COLOR_THEMES, applyColorTheme, applyMode, getStoredColorTheme, getStoredMode, getModePreference, initTheme } from "./theme.js";
import { hydrateIcons, openModal, closeModal, closeTopModal } from "./ui.js";
import { initUpdateBar } from "./update-bar.js";
import { initSettings } from "./settings.js";
import { initLeaderboard } from "./leaderboard.js";
import { initRanked } from "./ranked.js";
import { initGame } from "./game.js";

function buildThemeModal() {
  const grid = document.getElementById("swatchGrid");
  grid.innerHTML = COLOR_THEMES.map(
    (t) => `
      <button class="swatch" data-theme-id="${t.id}" style="--swatch-color:${t.hex}" type="button" aria-label="${t.label}">
        <span class="swatch-dot"></span>
        <span class="swatch-label">${t.label}</span>
      </button>`
  ).join("");

  syncThemeModalState();

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-id]");
    if (!btn) return;
    applyColorTheme(btn.dataset.themeId);
    syncThemeModalState();
  });

  document.getElementById("modeToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    applyMode(btn.dataset.mode);
    syncThemeModalState();
  });

  // A tab left open across 09:00 or 18:00 re-resolves itself; redraw the
  // modal so the note and pressed state stay in step with the change.
  document.addEventListener("uwu:modechange", syncThemeModalState);
}

function syncThemeModalState() {
  const activeTheme = getStoredColorTheme();
  const activePreference = getModePreference();
  const resolvedMode = getStoredMode();

  document.querySelectorAll("#swatchGrid .swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.themeId === activeTheme);
  });
  document.querySelectorAll("#modeToggle .mode-btn").forEach((el) => {
    const isActive = el.dataset.mode === activePreference;
    el.classList.toggle("active", isActive);
    el.setAttribute("aria-pressed", String(isActive));
  });

  const note = document.getElementById("modeNote");
  if (note) {
    note.hidden = activePreference !== "time";
    if (activePreference === "time") {
      note.textContent = `Following the clock. Currently ${resolvedMode}.`;
    }
  }

  updateThemeButtonIcon();
}

function updateThemeButtonIcon() {
  const span = document.querySelector("#themeBtn [data-icon]");
  span.setAttribute("data-icon", getStoredMode() === "dark" ? "moon" : "sun");
  hydrateIcons(document.getElementById("themeBtn"));
}

// Every modal: close button, backdrop click and Escape. ui.js moves focus in
// on open and back to the opener on close. The game ignores keys while
// body.modal-open is set.
function wireModals() {
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });
  document.addEventListener("keydown", (e) => {
    // Handled here, before anything else reads the key.
    if (e.key === "Escape" && closeTopModal()) e.preventDefault();
  });
}

function boot() {
  wireModals();
  document.getElementById("themeBtn").addEventListener("click", () => openModal("themeModal"));

  try {
    initTheme();
    hydrateIcons();
    updateThemeButtonIcon();
    buildThemeModal();
  } catch (cause) {
    // Storage blocked outright (some privacy settings throw on localStorage).
    // The page still renders light + classic from the stylesheet defaults.
    console.warn("theme unavailable:", cause);
    hydrateIcons();
  }

  initSettings();
  initLeaderboard();
  initRanked();
  initGame();
  initUpdateBar();
}

boot();
