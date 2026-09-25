-- Keeps each finished game's moves, so its score can be worked out again when
-- the scoring changes. Run after 001, and before deploying the site version
-- that sends the moves: /api/game/finish writes both new columns.
-- Safe to run again.
--
-- rules is the RULES_VERSION a game's score was last worked out under. When
-- the site's RULES_VERSION moves on, /api/leaderboard and submit replay any
-- game scored under an older one and call uwu2048_rescore with the new score.
-- Games finished before this migration have no log and stay as they were.

alter table uwu2048_games add column if not exists log text;
alter table uwu2048_games add column if not exists rules int;

-- Only games that can be rescored and still need to be.
create index if not exists uwu2048_games_rescore
  on uwu2048_games (rules)
  where log is not null and finished_at is not null;

-- Sets new scores for many games at once, on the game and on its leaderboard
-- entry together. A game already at p_rules or later is left alone, so two
-- rescores running side by side cannot undo each other.
create or replace function uwu2048_rescore(p_game_ids uuid[], p_scores int[], p_rules int)
returns void
language sql
volatile
as $$
  with changed as (
    update uwu2048_games g
    set score = n.score, rules = p_rules
    from unnest(p_game_ids, p_scores) as n(id, score)
    where g.id = n.id and g.rules < p_rules
    returning g.id, g.score
  )
  update uwu2048_leaderboard l
  set score = changed.score
  from changed
  where l.game_id = changed.id;
$$;

revoke all on function uwu2048_rescore(uuid[], int[], int) from public, anon, authenticated;
grant execute on function uwu2048_rescore(uuid[], int[], int) to service_role;
