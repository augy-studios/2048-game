#!/usr/bin/env node
// Checks that are easy to break without noticing. Run before a deploy:
//
//   node scripts/check.mjs
//
// 1. sw.js calls skipWaiting() and clients.claim() only in its message
//    handler, which is what keeps the update bar a question rather than a
//    silent takeover (update-bar-spec.md).
// 2. Every file sw.js precaches exists, and every script under js/ is
//    precached, or the game breaks offline.
// 3. A game played with js/engine.js passes the server's replay check, and
//    the same game with a changed score, a skipped move or autoplay's pace
//    does not.
// 4. Every tile's number clears 4.5:1 against its tile.
// 5. No em dashes in anything a reader sees.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const failures = [];
const fail = (message) => failures.push(message);

/* ---- 1. the worker waits ---- */

// Line comments first: the header prose could otherwise close a block
// comment early and swallow real code.
const sw = read("sw.js").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const handlerAt = sw.search(/addEventListener\(\s*["']message["']/);
if (handlerAt < 0) {
  fail("sw.js: no message handler, so nothing can promote the waiting worker");
} else {
  const before = sw.slice(0, handlerAt);
  const after = sw.slice(handlerAt).split(/self\.addEventListener\(\s*["']fetch["']/)[0];
  const rest = sw.slice(handlerAt + after.length);
  if (/skipWaiting\s*\(/.test(before + rest)) fail("sw.js: skipWaiting() is called outside the message handler");
  if (/clients\.claim\s*\(/.test(before + rest)) fail("sw.js: clients.claim() is called outside the message handler");
  if (!/["']skip-waiting["']/.test(after)) fail("sw.js: the message handler does not gate on 'skip-waiting'");
}
if (/cache\.addAll\s*\(/.test(sw)) fail("sw.js: cache.addAll() fails the whole install on one bad path");
if (!/cache:\s*["']reload["']/.test(sw)) fail("sw.js: precache fetches do not pass cache: 'reload'");
if (!/const VERSION\s*=\s*["'][^"']+["']/.test(sw)) fail("sw.js: no VERSION constant, the trigger for the update bar");

/* ---- 2. the precache list ---- */

const assets = [...read("sw.js").matchAll(/^\s*"(\/[^"]*)",?$/gm)].map((m) => m[1]);
for (const path of assets) {
  const file = path === "/" ? "index.html" : path.slice(1);
  if (!existsSync(join(ROOT, file))) fail(`sw.js precaches ${path}, which does not exist`);
}
for (const file of readdirSync(join(ROOT, "js"))) {
  if (file.endsWith(".js") && !assets.includes(`/js/${file}`)) fail(`sw.js does not precache /js/${file}`);
}

/* ---- 3. the replay check ---- */

const engine = await import("../main-site/js/engine.js");
const { check } = await import("../main-site/api/_lib/check.js");

function playOut(seed) {
  const game = engine.newGame(seed);
  // Down, left and right in turn, up only when stuck: ends in a few hundred moves.
  while (engine.canMove(game.board)) {
    if (!["D", "L", "R"].some((dir) => engine.move(game, dir))) engine.move(game, "U");
  }
  return game;
}

function claimFor(game, msPerMove) {
  const marks = [];
  for (let n = engine.MARK_EVERY; n <= game.moves.length; n += engine.MARK_EVERY) marks.push(n * msPerMove);
  return { score: game.score, top_tile: engine.topTile(game.board), log: game.moves, marks };
}

const game = playOut("check");
const human = claimFor(game, 300);
const elapsed = game.moves.length * 300 + 5000;

if (check("check", human, elapsed).reason) fail(`replay: a real game was refused (${check("check", human, elapsed).reason})`);
const refusals = {
  "a raised score": [{ ...human, score: human.score + 4 }, elapsed],
  "another seed": [human, elapsed, "other"],
  "a move that moved nothing": [{ ...human, log: human.log + "U".repeat(20) }, elapsed],
  "an unfinished game": [{ ...claimFor(engine.replay("check", game.moves.slice(0, 40)), 300) }, elapsed],
  "autoplay's pace": [claimFor(game, 60), elapsed],
  "more moves than the time allows": [human, 2000],
};
for (const [what, [claim, ms, seed = "check"]] of Object.entries(refusals)) {
  if (!check(seed, claim, ms).reason) fail(`replay: ${what} was accepted`);
}

// Rescoring an old game gives the score a fresh replay does under today's rules.
const { rescored } = await import("../main-site/api/_lib/rescore.js");
const [again] = rescored([{ id: "x", seed: "check", log: game.moves }]);
if (again?.score !== game.score) fail("rescore: an old game's new score does not match its replay");
if (rescored([{ id: "y", seed: "check", log: "UUUUUUUUUUUUUUUUUUUU" }]).length) fail("rescore: a log that does not replay was rescored");

/* ---- 4. tile contrast ---- */

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const css = read("style.css");
const token = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
const ink = token("tile-ink");
for (let v = 2; v <= engine.WIN_TILE; v *= 2) {
  const bg = token(`tile-${v}`);
  if (!bg) fail(`style.css: no --tile-${v}`);
  else if (contrast(ink, bg) < 4.5) fail(`style.css: the ${v} tile's number is ${contrast(ink, bg).toFixed(2)}:1`);
}
if (contrast(token("tile-super-ink"), token("tile-super")) < 4.5) fail("style.css: tiles past 2048 are under 4.5:1");

/* ---- 5. no em dashes ---- */

const files = ["index.html", "style.css", "sw.js", "manifest.json", ...readdirSync(join(ROOT, "js")).map((f) => `js/${f}`)];
for (const file of files) {
  if (read(file).includes("—")) fail(`${file} has an em dash`);
}

/* ---- report ---- */

if (failures.length) {
  console.error("check failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log(`ok: ${assets.length} precached files, replay check holds, tiles clear 4.5:1, no em dashes.`);
