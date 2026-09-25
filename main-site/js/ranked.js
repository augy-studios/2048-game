// Ranked games. A game asks the server for a seed as it starts, so where its
// tiles land is the server's choice; at the end, the server replays the moves
// from that seed before the score can go on the leaderboard. This module does
// both calls, and runs the name form on the end of game screen.

import { api } from "./api.js";
import { RULES_VERSION } from "./engine.js";
import { openLeaderboard } from "./leaderboard.js";
import { getSettings, saveSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString();

// Refusals that no retry will change. already_finished is not among them:
// it means an earlier try got through, and the game can still be added.
const FINAL = new Set(["implausible", "outdated", "already_submitted", "expired", "not_found", "no_score", "unfinished"]);

function localSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A seed for a new game: the server's, which makes the game ranked, or one
// made here when the server cannot be reached, which plays unranked.
export async function getTicket() {
  if (navigator.onLine === false) return { gameId: null, seed: localSeed(), unranked: "offline" };
  try {
    const r = await api.newGame(RULES_VERSION);
    return { gameId: r.game_id, seed: r.seed, unranked: null };
  } catch (err) {
    return { gameId: null, seed: localSeed(), unranked: err.code === "offline" ? "offline" : "unreachable" };
  }
}

// The game on the end screen, and a callback that stores it.
let current = null;

function say(text) {
  $("rankMsg").textContent = text;
}

function showForm(visible) {
  $("submitForm").hidden = !visible;
  $("submitBtn").disabled = false;
}

export function hideRank() {
  current = null;
  $("rankArea").hidden = true;
}

// Sends the moves once. A dropped connection may be retried; the server's
// refusals stand.
async function finish({ game, save }) {
  if (game.rank.finished) return;
  try {
    await api.finish(game.gameId, {
      rules: RULES_VERSION,
      score: game.stats.score,
      top_tile: game.stats.top_tile,
      log: game.moves,
      marks: game.marks,
    });
  } catch (err) {
    if (err.code !== "already_finished") throw err;
  }
  game.rank.finished = true;
  save();
}

// Called when a game ends, and again when a page opens on a game that had.
// `game` is the saved game from js/game.js; `save` stores it after a change.
export async function rankGame(game, save) {
  const entry = { game, save };
  current = entry;

  const prefs = getSettings();
  $("rankArea").hidden = false;
  $("nameInput").value = prefs.name ?? "";
  showForm(false);
  say("");

  if (game.assisted) {
    say("Autoplay was used in this game, so it is not ranked.");
    return;
  }
  if (!game.gameId) {
    say(
      game.unranked === "offline"
        ? "Played offline, so this game is not ranked."
        : "The leaderboard was out of reach when this game started, so it is not ranked."
    );
    return;
  }
  if (game.rank.submitted) {
    say(`Added as ${game.rank.submitted}.`);
    return;
  }
  if (game.stats.score <= 0) {
    say("Score some points to go on the leaderboard.");
    return;
  }

  try {
    await finish(entry);
  } catch (err) {
    if (entry !== current) return;
    if (FINAL.has(err.code)) {
      say(err.message || "This game could not be ranked.");
      return;
    }
    // Lost the connection at the last moment: offer the form, and submitting
    // sends the moves again first.
  }
  if (entry !== current) return;

  if (prefs.auto_submit && prefs.name) submitAs(entry, prefs.name, true);
  else showForm(true);
}

// Adds the game under a name, typed or saved. Any name that goes through
// becomes the saved one.
async function submitAs(entry, name, auto = false) {
  const { game, save } = entry;
  showForm(!auto);
  $("submitBtn").disabled = true;
  say(auto ? `Adding as ${name}.` : "");
  try {
    await finish(entry);
    const r = await api.submit(game.gameId, name);
    saveSettings({ name: r.name });
    game.rank.submitted = r.name;
    save();
    if (entry !== current) return;
    const games = r.games === 1 ? "1 game" : `${fmt(r.games)} games`;
    say(
      `Added as ${r.name}. Best score ${fmt(r.best_score)}, ranked ${r.rank}. ` +
        `Total ${fmt(r.total)} over ${games}, ranked ${r.total_rank}.`
    );
    showForm(false);
  } catch (err) {
    if (entry !== current) return;
    if (err.code === "offline") say("No connection. Try again once you are back online.");
    else if (auto && err.status === 400) say("Your saved name was refused, so this game was not added. Change it in Settings.");
    else if (auto && !FINAL.has(err.code)) say("This game could not be added automatically. Try the button.");
    else say(err.message || "That did not go through. Try again in a moment.");
    showForm(!FINAL.has(err.code));
  }
}

function onSubmit(event) {
  event.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) {
    say("Enter a name.");
    $("nameInput").focus();
    return;
  }
  if (current) submitAs(current, name);
}

export function initRanked() {
  $("submitForm").addEventListener("submit", onSubmit);
  $("overlayBoardBtn").addEventListener("click", () => openLeaderboard());
}
