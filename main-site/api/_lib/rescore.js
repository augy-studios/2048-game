// Brings old games onto the current scoring. Every finished game keeps its
// moves and the RULES_VERSION it was scored under; when the scoring changes,
// replaying the moves gives the score the game has under the new rules, and
// the leaderboard shows that instead.
//
// Called before the leaderboard is read and before a game is submitted, so
// both always rank on one scale. A batch at a time: the first reads after a
// change do the work, and every read after finds nothing left to do.

import { RULES_VERSION, SAVES_FROM, replay } from "../../js/engine.js";
import { rest, rpc } from "./supabase.js";

const BATCH = 200;

// New scores for games scored under older rules, as [{ id, score }]. Pure, so
// scripts/check.mjs can run it.
export function rescored(rows) {
  const out = [];
  for (const row of rows) {
    const game = replay(row.seed, row.log);
    // Only if a rule change moved where tiles land, which SAVES_FROM rules out.
    if (!game) {
      console.warn(`game ${row.id} no longer replays; left at its old score`);
      continue;
    }
    out.push({ id: row.id, score: game.score });
  }
  return out;
}

export async function rescoreOldGames() {
  for (let round = 0; round < 5; round++) {
    const rows =
      (await rest(
        `uwu2048_games?select=id,seed,log&rules=gte.${SAVES_FROM}&rules=lt.${RULES_VERSION}` +
          `&log=not.is.null&finished_at=not.is.null&limit=${BATCH}`
      )) ?? [];
    if (!rows.length) return;

    const scores = rescored(rows);
    if (scores.length) {
      await rpc("uwu2048_rescore", {
        p_game_ids: scores.map((s) => s.id),
        p_scores: scores.map((s) => s.score),
        p_rules: RULES_VERSION,
      });
    }
    if (rows.length < BATCH || scores.length < rows.length) return;
  }
}
