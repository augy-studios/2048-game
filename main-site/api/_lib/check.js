// Checks a finished game before it can be ranked. The game runs in the
// browser, so what it sends is a claim. The anti-cheat, simple on purpose:
//
//   seed     where every tile lands comes from the seed /api/game/new handed
//            out, so replaying the moves gives the one board and score the
//            game could have had. Nobody picks their own tiles.
//   moves    every move must have moved something, as the page only ever
//            records one that did.
//   score    the claimed score and top tile must match the replay's.
//   end      a game ends when no move is left, or once it has reached 2048
//            and the player stops.
//   pace     no stretch of MARK_EVERY moves faster than MAX_MOVES_PER_SECOND,
//            by the page's own marks, and never more moves than that pace
//            allows in the time since /new, by the server's clock. Autoplay
//            is faster than both, so a game that hid its autoplay still
//            fails here.
//
// It cannot tell a person from a patient script that plays at human speed.
// A refused game logs its reason on the server; the reply only says
// "implausible", since naming the check helps whoever is testing it.

import { MARK_EVERY, MAX_MOVES_PER_SECOND, WIN_TILE, canMove, replay, statsOf } from "../../js/engine.js";

// A game can be put down and picked up days later: the page saves it.
export const MAX_GAME_MS = 7 * 24 * 60 * 60 * 1000;

// Far past any real game; 65536 takes around 30,000 moves.
const MAX_MOVES = 200000;

// The page's clock starts a moment after the server's, and phones drift.
const CLOCK_SLACK_MS = 10000;
const PACE_SLACK_MOVES = 20;

const MIN_MARK_GAP_MS = (MARK_EVERY / MAX_MOVES_PER_SECOND) * 1000;

// The claim as sent, checked for shape, or null.
export function readClaim(body) {
  const { score, top_tile: topTile, log, marks } = body;
  if (!Number.isInteger(score) || score < 0 || score > 1e8) return null;
  if (!Number.isInteger(topTile) || topTile < 2 || topTile > 1 << 18) return null;
  if (typeof log !== "string" || log.length > MAX_MOVES || !/^[UDLR]*$/.test(log)) return null;
  if (!Array.isArray(marks) || !marks.every((m) => Number.isInteger(m) && m >= 0 && m <= MAX_GAME_MS)) return null;
  return { score, top_tile: topTile, log, marks };
}

// Why the claim cannot be real, or null with the replayed stats when it could.
export function check(seed, claim, elapsedMs) {
  const fail = (reason) => ({ reason });

  const game = replay(seed, claim.log);
  if (!game) return fail("replay");

  const stats = statsOf(game);
  if (stats.score !== claim.score || stats.top_tile !== claim.top_tile) return fail("mismatch");
  if (canMove(game.board) && stats.top_tile < WIN_TILE) return fail("unfinished");

  // One mark every MARK_EVERY moves, in order, each far enough after the last.
  if (claim.marks.length !== Math.floor(stats.moves / MARK_EVERY)) return fail("marks");
  let last = 0;
  for (const mark of claim.marks) {
    if (mark - last < MIN_MARK_GAP_MS) return fail("pace");
    last = mark;
  }
  if (last > elapsedMs + CLOCK_SLACK_MS) return fail("clock");
  if (stats.moves > (elapsedMs / 1000) * MAX_MOVES_PER_SECOND + PACE_SLACK_MOVES) return fail("pace");

  return { stats };
}
