// POST /api/game/finish  { game_id, client_key, rules, score, top_tile, log, marks }
//   -> { game_id, score, top_tile, moves }
// Records a game's final numbers once, when it ends, if a replay of its moves
// from the game's seed comes to the same numbers (see _lib/check.js). Submit
// reads the score from here, never from its own request.

import { RULES_VERSION } from "../../js/engine.js";
import { check, MAX_GAME_MS, readClaim } from "../_lib/check.js";
import { clientKey, endpoint, gameId, HttpError } from "../_lib/http.js";
import { rest } from "../_lib/supabase.js";

export default endpoint("POST", async ({ body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  if (body.rules !== RULES_VERSION) {
    throw new HttpError(400, "outdated", "This copy of the game is out of date, so this game cannot be ranked.");
  }
  const claim = readClaim(body);
  if (!claim) throw new HttpError(400, "bad_claim", "That game's details are not readable.");

  const [game] = (await rest(`uwu2048_games?id=eq.${id}&select=client_key,seed,started_at,finished_at`)) ?? [];
  // Another page's game looks the same as no game at all.
  if (!game || game.client_key !== key) throw new HttpError(404, "not_found", "That game does not exist.");
  if (game.finished_at) throw new HttpError(409, "already_finished", "That game is already over.");

  const elapsed = Date.now() - Date.parse(game.started_at);
  if (elapsed > MAX_GAME_MS) throw new HttpError(410, "expired", "That game is too old to rank.");

  const result = check(game.seed, claim, elapsed);
  if (result.reason) {
    console.warn(`game ${id} refused: ${result.reason}`);
    throw new HttpError(422, "implausible", "That score does not fit the game that was played.");
  }

  // Conditional on still being unfinished, so two finishes cannot both land.
  const [saved] =
    (await rest(`uwu2048_games?id=eq.${id}&finished_at=is.null`, {
      method: "PATCH",
      body: { ...result.stats, finished_at: new Date().toISOString() },
      prefer: "return=representation",
    })) ?? [];
  if (!saved) throw new HttpError(409, "already_finished", "That game is already over.");

  return { game_id: id, score: saved.score, top_tile: saved.top_tile, moves: saved.moves };
});
