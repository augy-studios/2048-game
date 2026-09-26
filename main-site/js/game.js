// The game on the page: the board and its animation, keys and swipes, the
// win and end screens, saving the game in progress, replays and autoplay.
// The rules themselves are in js/engine.js.

import {
  CELLS,
  MARK_EVERY,
  RULES_VERSION,
  SAVES_FROM,
  WIN_TILE,
  canMove,
  fromPosition,
  move,
  newGame,
  positionOf,
  replay as replayMoves,
  statsOf,
  topTile,
} from "./engine.js";
import { SEED_PATTERN, getTicket, hideRank, rankGame } from "./ranked.js";
import { closeModal, hydrateIcons, openModal } from "./ui.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString();

const SAVE_KEY = "uwu2048.game";
const BEST_KEY = "uwu2048.best";

// Match the tile transition in style.css.
const SLIDE_MS = 150;
// A finger has to travel this far before it counts as a swipe.
const SWIPE_PX = 28;

// Autoplay: thinking time per move, and the least time between two moves.
// Both well under what a person takes.
const AUTO_BUDGET_MS = 40;
const AUTO_MIN_STEP_MS = 50;

let engine = null; // the game's board, score, moves and generator
let record = null; // everything else about it, saved alongside
let starting = 0; // bumped for every new game, so a slow seed cannot land late

const els = {};

/* ---- saving ---- */

function save() {
  if (!record || !engine) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...record, moves: engine.moves }));
  } catch {
    // Storage full or blocked: the game carries on, unsaved.
  }
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? "null");
    if (
      !saved ||
      !(saved.rules >= SAVES_FROM && saved.rules <= RULES_VERSION) ||
      typeof saved.seed !== "string" ||
      typeof saved.moves !== "string"
    ) {
      return null;
    }
    // The board is played again from the seed rather than stored, so a saved
    // game is always one the rules could have produced, and one saved under
    // older rules comes back scored by these.
    const game = replayMoves(saved.seed, saved.moves);
    if (!game) return null;
    saved.rules = RULES_VERSION;
    return { saved, game };
  } catch {
    return null;
  }
}

// This browser's best game: its score, and its seed and moves, so that when
// the scoring changes it is replayed and shown on the new scale like any
// other old game. { score, rules, seed, moves }; a bare number in storage is
// from before bests kept their moves, and stays as it is.
let best = { score: 0 };

function storeBest() {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    // Shown for this page view only.
  }
}

function loadBest() {
  try {
    const raw = localStorage.getItem(BEST_KEY) ?? "0";
    best = raw.startsWith("{") ? JSON.parse(raw) : { score: Number(raw) || 0 };
  } catch {
    best = { score: 0 };
    return;
  }
  if (typeof best.seed === "string" && best.rules >= SAVES_FROM && best.rules < RULES_VERSION) {
    const game = replayMoves(best.seed, best.moves);
    if (game) {
      best = { score: game.score, rules: RULES_VERSION, seed: game.seed, moves: game.moves };
      storeBest();
    }
  }
}

function noteBest() {
  if (!engine || engine.score <= best.score) return;
  best = { score: engine.score, rules: RULES_VERSION, seed: engine.seed, moves: engine.moves };
  storeBest();
}

/* ---- drawing ---- */

let tileEls = new Array(CELLS).fill(null);
let leftovers = [];
let settleTimer = 0;

function place(el, at) {
  el.style.setProperty("--r", String(at >> 2));
  el.style.setProperty("--c", String(at & 3));
}

function makeTile(value, at, kind) {
  const el = document.createElement("div");
  const digits = Math.min(String(value).length, 6);
  el.className = `tile ${value <= WIN_TILE ? `tile-${value}` : "tile-super"} digits-${digits}${kind ? ` is-${kind}` : ""}`;
  el.textContent = value;
  place(el, at);
  els.tiles.append(el);
  return el;
}

// Tiles that merged away, removed once they have slid under the new one.
function settle() {
  clearTimeout(settleTimer);
  leftovers.forEach((el) => el.remove());
  leftovers = [];
}

function drawAll(fresh = false) {
  settle();
  els.tiles.replaceChildren();
  tileEls = engine ? engine.board.map((v, i) => (v ? makeTile(v, i, fresh ? "new" : null) : null)) : new Array(CELLS).fill(null);
  drawScore();
}

function drawMove(result) {
  settle();
  const next = new Array(CELLS).fill(null);
  for (const s of result.slides) {
    const el = tileEls[s.from];
    place(el, s.to);
    if (s.merged) {
      leftovers.push(el, next[s.to]);
      next[s.to] = makeTile(s.value * 2, s.to, "merged");
    } else {
      next[s.to] = el;
    }
  }
  if (result.spawned) next[result.spawned.at] = makeTile(result.spawned.value, result.spawned.at, "new");
  tileEls = next;
  settleTimer = setTimeout(settle, SLIDE_MS);
  drawScore();
}

function drawScore() {
  const score = engine?.score ?? 0;
  noteBest();
  els.score.textContent = fmt(score);
  els.best.textContent = fmt(best.score);
  els.undo.disabled = !canUndo();
  els.board.setAttribute(
    "aria-label",
    engine ? `Game board. Score ${fmt(score)}. Highest tile ${topTile(engine.board)}.` : "Game board"
  );
}

/* ---- the overlay on the board ---- */

// mode: "starting", "won" or "ended".
function showOverlay(mode) {
  const stats = engine ? statsOf(engine) : null;
  els.overlay.dataset.mode = mode;

  if (mode === "starting") {
    els.overlayTitle.textContent = "New game";
    els.overlaySub.textContent = "Getting the board ready.";
  } else if (mode === "won") {
    els.overlayTitle.textContent = `You made ${WIN_TILE}`;
    els.overlaySub.textContent = "Keep going for a higher score, or end the game here.";
    els.primary.textContent = "Keep going";
    els.primary.dataset.act = "keep-going";
    els.secondary.textContent = "End game";
    els.secondary.dataset.act = "end-game";
  } else {
    els.overlayTitle.textContent = canMove(engine.board) ? "Game ended" : "Game over";
    els.overlaySub.textContent = `Score ${fmt(stats.score)}. Highest tile ${stats.top_tile}.`;
    els.primary.textContent = "New game";
    els.primary.dataset.act = "new-game";
    els.secondary.textContent = "Play a seed";
    els.secondary.dataset.act = "seed";
    els.seedValue.textContent = record.seed;
    els.copySeed.textContent = "Copy";
    els.seedMsg.textContent = "";
  }
  // Only once the game is over: mid game, the seed would let another tab
  // try moves ahead and see where the tiles land.
  els.seedRow.hidden = mode !== "ended";
  // A game with no moves has nothing to watch.
  els.replayBtn.hidden = mode !== "ended" || !engine?.moves.length;
  els.secondary.hidden = mode === "starting";
  els.actions.hidden = mode === "starting";
  els.overlay.classList.remove("hidden");
  if (mode !== "starting") els.primary.focus({ preventScroll: true });
}

function hideOverlay() {
  els.overlay.classList.add("hidden");
}

const overlayOpen = () => !els.overlay.classList.contains("hidden");

/* ---- playing ---- */

function play(dir) {
  if (!engine || !record || record.ended || overlayOpen()) return false;

  const result = move(engine, dir);
  if (!result) return false;

  if (engine.moves.length % MARK_EVERY === 0) record.marks.push(Date.now() - record.startedAt);
  drawMove(result);

  if (!record.won && topTile(engine.board) >= WIN_TILE) {
    record.won = true;
    if (autoplay) {
      // Autoplay is going for more than 2048, and does not stop to ask.
      record.keepGoing = true;
    } else {
      save();
      showOverlay("won");
      return true;
    }
  }
  if (!canMove(engine.board)) {
    endGame();
    return true;
  }
  save();
  return true;
}

// Any move by hand takes over from autoplay.
function playByHand(dir) {
  if (autoplay) stopAutoplay();
  play(dir);
}

function endGame() {
  stopAutoplay();
  record.ended = true;
  record.stats = statsOf(engine);
  record.moves = engine.moves;
  save();
  showOverlay("ended");
  rankGame(record, save);
}

// A new game, from the server's seed, or from `pasted` when the player gave one.
async function startGame(pasted = null) {
  const token = ++starting;
  stopAutoplay();
  closeReplay(false);
  hideRank();
  engine = null;
  record = null;
  drawAll();
  showOverlay("starting");

  const ticket = await getTicket(pasted);
  if (token !== starting) return;

  engine = newGame(ticket.seed);
  record = {
    rules: RULES_VERSION,
    seed: ticket.seed,
    gameId: ticket.gameId,
    unranked: ticket.unranked,
    startedAt: Date.now(),
    marks: [],
    won: false,
    keepGoing: false,
    ended: false,
    assisted: false,
    undone: false,
    stats: null,
    rank: { finished: false, submitted: null },
  };
  save();
  hideOverlay();
  drawAll(true);
}

/* ---- replay ----
   The finished game played back on the board, to see where it went wrong.
   Every position is worked out once when the replay opens, so stepping back
   is a lookup and stepping forward animates the real move. Only for a game
   that has ended: mid game it would show where the next tiles land. */

// At 1x, a move every REPLAY_STEP_MS, long enough to follow each slide.
const REPLAY_STEP_MS = 400;
const REPLAY_SPEEDS = [1, 2, 4, 8];
const DIRECTION_NAMES = { U: "up", D: "down", L: "left", R: "right" };

let replay = null; // { moves, positions, at, playing, speed, timer }

function openReplay() {
  if (!engine || !record?.ended || !engine.moves.length) return;
  stopAutoplay();

  const moves = engine.moves;
  const game = newGame(record.seed);
  const positions = [positionOf(game)];
  for (const dir of moves) {
    move(game, dir);
    positions.push(positionOf(game));
  }
  replay = { moves, positions, at: 0, playing: false, speed: 1, timer: 0 };

  hideOverlay();
  els.undo.disabled = true;
  $("playHint").hidden = true;
  els.replayBar.hidden = false;
  els.seek.max = String(moves.length);
  drawReplayUi();
  drawReplayPosition();
  setReplayPlaying(true);
  els.replayBar.querySelector('[data-replay="play"]').focus({ preventScroll: true });
}

// `toEnd`: back to the end of game screen. Starting a new game passes false.
function closeReplay(toEnd = true) {
  if (!replay) return;
  clearTimeout(replay.timer);
  replay = null;
  els.replayBar.hidden = true;
  $("playHint").hidden = false;
  els.board.classList.remove("fast");
  if (!toEnd) return;
  drawAll();
  showOverlay("ended");
}

// Draws the board at the replay's position, with no animation.
function drawReplayPosition() {
  settle();
  els.tiles.replaceChildren();
  tileEls = replay.positions[replay.at].board.map((v, i) => (v ? makeTile(v, i, null) : null));
  drawReplayUi();
}

function drawReplayUi() {
  const { moves, at, positions, playing, speed } = replay;
  const total = moves.length;
  els.replayStatus.textContent =
    at === 0 ? `Start, ${fmt(total)} moves to go` : `Move ${fmt(at)} of ${fmt(total)}, ${DIRECTION_NAMES[moves[at - 1]]}`;
  els.replayScore.textContent = `Score ${fmt(positions[at].score)}`;
  els.seek.value = String(at);
  els.seek.setAttribute("aria-valuetext", at === 0 ? "Start" : `Move ${at} of ${total}`);

  const bar = els.replayBar;
  bar.querySelector('[data-replay="start"]').disabled = at === 0;
  bar.querySelector('[data-replay="back"]').disabled = at === 0;
  bar.querySelector('[data-replay="forward"]').disabled = at === total;
  bar.querySelector('[data-replay="end"]').disabled = at === total;

  const playBtn = bar.querySelector('[data-replay="play"]');
  playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  playBtn.querySelector("[data-icon]").dataset.icon = playing ? "pause" : "play";
  hydrateIcons(playBtn);

  const speedBtn = bar.querySelector('[data-replay="speed"]');
  speedBtn.textContent = `${speed}×`;
  speedBtn.setAttribute("aria-label", `Speed, ${speed} times`);
}

// One move on, animated as it was played. False at the end.
function replayForward() {
  const r = replay;
  if (r.at >= r.moves.length) return false;
  const game = fromPosition(record.seed, r.positions[r.at]);
  const result = move(game, r.moves[r.at]);
  r.at++;
  drawMove(result);
  drawReplayUi();
  return true;
}

function replaySeek(at) {
  replay.at = Math.max(0, Math.min(replay.moves.length, at));
  drawReplayPosition();
}

function setReplayPlaying(on) {
  const r = replay;
  clearTimeout(r.timer);
  r.playing = on;
  // Play at the end starts over.
  if (on && r.at >= r.moves.length) replaySeek(0);
  drawReplayUi();
  if (!on) return;

  const tick = () => {
    if (!replay?.playing) return;
    if (!replayForward()) {
      setReplayPlaying(false);
      return;
    }
    replay.timer = setTimeout(tick, REPLAY_STEP_MS / replay.speed);
  };
  r.timer = setTimeout(tick, REPLAY_STEP_MS / r.speed);
}

function onReplayAction(act) {
  if (!replay) return;
  if (act === "play") setReplayPlaying(!replay.playing);
  else if (act === "close") closeReplay();
  else if (act === "speed") {
    replay.speed = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(replay.speed) + 1) % REPLAY_SPEEDS.length];
    // Past 2x the usual slide would still be running when the next move lands.
    els.board.classList.toggle("fast", replay.speed > 2);
    setReplayPlaying(replay.playing);
  } else {
    // Stepping or jumping pauses, so the move stays on screen to look at.
    setReplayPlaying(false);
    if (act === "back") replaySeek(replay.at - 1);
    else if (act === "forward") replayForward();
    else if (act === "start") replaySeek(0);
    else if (act === "end") replaySeek(replay.moves.length);
  }
}

const REPLAY_KEYS = {
  " ": "play",
  k: "play",
  ArrowLeft: "back",
  j: "back",
  ArrowRight: "forward",
  l: "forward",
  Home: "start",
  End: "end",
  Escape: "close",
};

/* ---- undo ----
   Any number of moves, back to the first. The game before the last move is
   played again from the seed, generator and all, so moving the same way
   again brings the same tile. That shows where tiles are about to land, so a
   game with a move undone is not ranked, as with autoplay. Works from the
   end of game screen too: a score already added stays on the leaderboard,
   and the game plays on unranked. */

const canUndo = () => Boolean(engine && record && !replay && engine.moves.length);

// A ranked game asks first, once.
function requestUndo() {
  if (!canUndo()) return;
  if (record.gameId && !record.assisted && !record.undone) {
    openModal("undoModal");
    return;
  }
  undo();
}

function undo() {
  if (!canUndo()) return;
  const game = replayMoves(record.seed, engine.moves.slice(0, -1));
  if (!game) return;

  stopAutoplay();
  hideRank();
  engine = game;
  record.undone = true;
  record.ended = false;
  record.stats = null;
  record.marks.length = Math.min(record.marks.length, Math.floor(engine.moves.length / MARK_EVERY));
  // Back below 2048, making it again shows the win screen again.
  if (topTile(engine.board) < WIN_TILE) {
    record.won = false;
    record.keepGoing = false;
  }
  save();
  hideOverlay();
  drawAll();
}

/* ---- seeds ---- */

// The New game dialog: an optional seed, and a warning when a game with
// moves in it would be lost.
function openNewGame() {
  $("newGameWarning").hidden = !(engine && record && !record.ended && engine.moves.length > 0);
  $("seedInput").value = "";
  $("seedError").textContent = "";
  openModal("newGameModal");
  $("seedInput").focus();
}

function onNewGameSubmit(event) {
  event.preventDefault();
  const seed = $("seedInput").value.trim();
  if (seed && !SEED_PATTERN.test(seed)) {
    $("seedError").textContent = "A seed is up to 64 letters, numbers, hyphens and underscores.";
    $("seedInput").focus();
    return;
  }
  closeModal("newGameModal");
  startGame(seed || null);
}

async function copySeed() {
  const seed = record?.seed;
  if (!seed) return;
  try {
    await navigator.clipboard.writeText(seed);
    els.copySeed.textContent = "Copied";
    els.seedMsg.textContent = "Seed copied.";
  } catch {
    // No clipboard access: select it, so a long press or Ctrl+C copies it.
    getSelection()?.selectAllChildren(els.seedValue);
    els.seedMsg.textContent = "Seed selected. Copy it from here.";
  }
}

function onOverlayAction(act) {
  if (act === "keep-going") {
    record.keepGoing = true;
    save();
    hideOverlay();
    // The tile that made 2048 can also have filled the board.
    if (!canMove(engine.board)) endGame();
  } else if (act === "end-game") {
    endGame();
  } else if (act === "new-game") {
    startGame();
  } else if (act === "seed") {
    openNewGame();
  } else if (act === "replay") {
    openReplay();
  }
}

/* ---- autoplay ----
   F2, or three quick taps on the game's name on a touch screen, both left
   out of every hint on purpose. Turning it on at any point marks this game
   as assisted, which keeps it off the leaderboard; a new game starts clean. */

let autoplay = false;
let worker = null;
let thinkId = 0;
const waiting = new Map();

function mainThreadThink(board) {
  return import("./autoplay.js").then((m) => m.chooseMove(board, AUTO_BUDGET_MS));
}

function think(board) {
  if (worker === null) {
    try {
      worker = new Worker("/js/autoplay-worker.js", { type: "module" });
      worker.addEventListener("message", (e) => {
        waiting.get(e.data.id)?.(e.data.dir);
        waiting.delete(e.data.id);
      });
      worker.addEventListener("error", () => {
        // No module workers here: think on the page instead.
        worker = false;
        for (const [, resolve] of waiting) resolve(undefined);
        waiting.clear();
      });
    } catch {
      worker = false;
    }
  }
  if (!worker) return mainThreadThink(board);

  const id = ++thinkId;
  return new Promise((resolve) => {
    waiting.set(id, (dir) => resolve(dir === undefined ? mainThreadThink(board) : dir));
    worker.postMessage({ id, board, budget: AUTO_BUDGET_MS });
  });
}

let autoRun = 0;

async function autoStep(run) {
  const began = performance.now();
  const dir = await think(engine.board.slice());
  if (!autoplay || run !== autoRun) return;

  const wait = Math.max(0, AUTO_MIN_STEP_MS - (performance.now() - began));
  setTimeout(() => {
    if (!autoplay || run !== autoRun) return;
    if (!dir || !play(dir)) {
      stopAutoplay();
      return;
    }
    if (autoplay) autoStep(run);
  }, wait);
}

function startAutoplay() {
  if (!engine || !record || record.ended || overlayOpen()) return;
  autoplay = true;
  record.assisted = true;
  save();
  els.board.classList.add("fast");
  autoStep(++autoRun);
}

function stopAutoplay() {
  autoplay = false;
  autoRun++;
  els.board?.classList.remove("fast");
}

function toggleAutoplay() {
  if (autoplay) stopAutoplay();
  else startAutoplay();
}

// The touch screen's F2: three taps on the game's name, each within
// TRIPLE_TAP_GAP_MS of the last. Touch and pen only, so clicking the title
// with a mouse does nothing.
const TRIPLE_TAP_GAP_MS = 400;

function wireTitleTaps() {
  const title = document.querySelector(".app-title");
  let taps = 0;
  let last = -Infinity;

  title?.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    if (document.body.classList.contains("modal-open")) return;
    taps = e.timeStamp - last <= TRIPLE_TAP_GAP_MS ? taps + 1 : 1;
    last = e.timeStamp;
    if (taps < 3) return;
    taps = 0;
    toggleAutoplay();
  });
}

/* ---- input ---- */

const KEYS = {
  ArrowUp: "U",
  ArrowDown: "D",
  ArrowLeft: "L",
  ArrowRight: "R",
  w: "U",
  s: "D",
  a: "L",
  d: "R",
};

function typing(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKey(e) {
  if (e.altKey || document.body.classList.contains("modal-open") || typing(e)) return;

  // Ctrl+Z, Cmd+Z or U. Held down, it keeps stepping back.
  const key = e.key.toLowerCase();
  if (!replay && !e.shiftKey && ((e.ctrlKey || e.metaKey) ? key === "z" : key === "u")) {
    e.preventDefault();
    requestUndo();
    return;
  }
  if (e.ctrlKey || e.metaKey) return;

  if (replay) {
    const act = REPLAY_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    // Space or Enter on a focused control is that control's own click.
    if (!act || (e.target instanceof HTMLButtonElement && (e.key === " " || e.key === "Enter"))) return;
    e.preventDefault();
    onReplayAction(act);
    return;
  }

  if (e.key === "F2") {
    e.preventDefault();
    toggleAutoplay();
    return;
  }

  const dir = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!dir) return;
  // Arrow keys would otherwise scroll the page.
  e.preventDefault();
  if (e.repeat) return;
  playByHand(dir);
}

// Swipes on the board. The board has touch-action: none, so the browser
// does not scroll, refresh or go back while a finger is on it. A swipe
// counts as soon as it has travelled SWIPE_PX, one move per touch.
function wireSwipes() {
  let swipe = null;
  const frame = els.frame;
  const onOverlay = (e) => e.target instanceof Element && e.target.closest(".board-overlay");

  frame.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary || e.button > 0 || onOverlay(e)) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, done: false };
  });

  frame.addEventListener("pointermove", (e) => {
    if (!swipe || swipe.done || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    swipe.done = true;
    // The way the finger went is the way the tiles go.
    playByHand(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "R" : "L") : dy > 0 ? "D" : "U");
  });

  const end = (e) => {
    if (swipe && e.pointerId === swipe.id) swipe = null;
  };
  frame.addEventListener("pointerup", end);
  frame.addEventListener("pointercancel", end);

  // Older iOS Safari ignores touch-action for some gestures.
  frame.addEventListener(
    "touchmove",
    (e) => {
      if (!onOverlay(e)) e.preventDefault();
    },
    { passive: false }
  );
}

/* ---- start ---- */

export function initGame() {
  Object.assign(els, {
    frame: $("boardFrame"),
    board: $("board"),
    tiles: $("tiles"),
    score: $("score"),
    best: $("best"),
    overlay: $("boardOverlay"),
    overlayTitle: $("overlayTitle"),
    overlaySub: $("overlaySub"),
    actions: $("overlayActions"),
    primary: $("overlayPrimary"),
    secondary: $("overlaySecondary"),
    seedRow: $("seedRow"),
    seedValue: $("seedValue"),
    seedMsg: $("seedMsg"),
    copySeed: $("copySeedBtn"),
    replayBtn: $("overlayReplay"),
    replayBar: $("replayBar"),
    replayStatus: $("replayStatus"),
    replayScore: $("replayScore"),
    seek: $("replaySeek"),
    undo: $("undoBtn"),
  });

  // The sixteen empty cells under the tiles.
  const cells = document.createDocumentFragment();
  for (let i = 0; i < CELLS; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cells.append(cell);
  }
  $("cells").append(cells);

  loadBest();
  document.addEventListener("keydown", onKey);
  wireSwipes();
  wireTitleTaps();
  $("newGameBtn").addEventListener("click", openNewGame);
  $("newGameForm").addEventListener("submit", onNewGameSubmit);
  els.undo.addEventListener("click", requestUndo);
  $("undoConfirmBtn").addEventListener("click", () => {
    closeModal("undoModal");
    undo();
  });
  els.copySeed.addEventListener("click", copySeed);
  els.replayBtn.addEventListener("click", () => onOverlayAction("replay"));
  els.replayBar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-replay]");
    if (btn) onReplayAction(btn.dataset.replay);
  });
  els.seek.addEventListener("input", () => {
    if (!replay) return;
    // Read before pausing: pausing redraws the slider at the old position.
    const to = Number(els.seek.value);
    setReplayPlaying(false);
    replaySeek(to);
  });
  [els.primary, els.secondary].forEach((btn) => btn.addEventListener("click", () => onOverlayAction(btn.dataset.act)));

  const restored = loadSaved();
  if (!restored) {
    startGame();
    return;
  }

  engine = restored.game;
  record = restored.saved;
  record.marks = Array.isArray(record.marks) ? record.marks : [];
  record.rank ??= { finished: false, submitted: null };
  // Stores the game under the current rules straight away, rescored if it
  // was saved under older ones.
  save();
  drawAll(true);

  if (record.ended) {
    record.stats = statsOf(engine);
    showOverlay("ended");
    rankGame(record, save);
  } else if (record.won && !record.keepGoing) {
    showOverlay("won");
  } else if (!canMove(engine.board)) {
    endGame();
  }
}
