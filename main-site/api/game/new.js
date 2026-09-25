// POST /api/game/new  { client_key, rules } -> { game_id, seed, started_at }
// Called when a game starts. The seed decides where every tile lands, and
// the start time is the server's; finish checks the game against both.

import { randomBytes, randomInt } from "node:crypto";
import { RULES_VERSION } from "../../js/engine.js";
import { clientKey, endpoint, HttpError } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";

export default endpoint("POST", async ({ body }) => {
  const key = clientKey(body.client_key);
  // A copy of the page from before a rules change, still cached by the
  // service worker: its games would replay differently here.
  if (body.rules !== RULES_VERSION) {
    throw new HttpError(400, "outdated", "This copy of the game is out of date. Reload to update it.");
  }

  const [game] = await rest("uwu2048_games", {
    method: "POST",
    body: { client_key: key, seed: randomBytes(16).toString("hex") },
    prefer: "return=representation",
  });

  // Now and then, clear out games nobody added to the leaderboard.
  if (randomInt(50) === 0) rpc("uwu2048_prune", {}).catch((err) => console.warn("prune failed:", err.message));

  return { game_id: game.id, seed: game.seed, started_at: game.started_at };
});
