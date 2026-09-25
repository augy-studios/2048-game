// POST /api/leaderboard/submit  { game_id, name }
//   -> { name, rank, best_score, total, games, total_rank }
// rank and best_score are the best-score board; total, games and total_rank
// are the cumulative one. The score is read from the finished game, never
// taken from this request.

import { endpoint, gameId, HttpError } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rpc } from "../_lib/supabase.js";

const REFUSALS = {
  not_found: [404, "That game does not exist."],
  unfinished: [409, "Only a finished game can go on the leaderboard."],
  no_score: [409, "Score some points to go on the leaderboard."],
  already_submitted: [409, "That game is already on the leaderboard."],
  expired: [410, "That game ended more than an hour ago."],
};

export default endpoint("POST", async ({ body }) => {
  const id = gameId(body.game_id);
  const name = cleanName(body.name);

  const [row] = (await rpc("uwu2048_submit", { p_game_id: id, p_name: name })) ?? [];
  if (row?.status !== "ok") {
    const [status, message] = REFUSALS[row?.status] ?? [500, "Could not submit."];
    throw new HttpError(status, row?.status ?? "server", message);
  }

  return {
    name,
    rank: Number(row.rank),
    best_score: row.best_score,
    total: Number(row.total),
    games: row.games,
    total_rank: Number(row.total_rank),
  };
});
