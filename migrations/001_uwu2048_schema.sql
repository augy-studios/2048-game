-- 2048 Game leaderboards, in the shared uwuapps Supabase project.
-- Paste into the Supabase SQL editor and run once.
-- Safe to run again: everything is "if not exists" or "or replace".
--
-- Access model: only the Vercel functions touch these tables, with the service
-- role key. There is no Supabase Auth here. RLS is on with no policies, so an
-- anon key reads nothing.

-- One row per game started online. The seed decides where every tile lands,
-- and the start time is the server's; finish replays the game's moves from
-- the seed and checks them against the time since started_at.
create table if not exists uwu2048_games (
  id uuid primary key default gen_random_uuid(),
  client_key text not null,
  seed text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  score int,
  top_tile int,
  moves int,
  submitted boolean not null default false
);

create index if not exists uwu2048_games_started
  on uwu2048_games (started_at);

create table if not exists uwu2048_leaderboard (
  id bigserial primary key,
  name text not null,
  score int not null,
  top_tile int not null,
  game_id uuid not null unique references uwu2048_games(id),
  created_at timestamptz not null default now()
);

create index if not exists uwu2048_lb_best
  on uwu2048_leaderboard (lower(name), score desc);

alter table uwu2048_games enable row level security;
alter table uwu2048_leaderboard enable row level security;

-- Each name's best game. The earliest of an equal top score wins, and the
-- casing shown is the one attached to that score.
create or replace view uwu2048_leaderboard_best
with (security_invoker = true) as
select distinct on (lower(name)) name, score, top_tile, created_at
from uwu2048_leaderboard
order by lower(name), score desc, created_at asc;

-- Every submitted game's score added up per name (case-insensitive). The
-- casing shown is the name's most recent submission. Ranked by total; ties go
-- to fewer games, then to whoever reached it first, the earlier last_at.
create or replace view uwu2048_leaderboard_total
with (security_invoker = true) as
select
  (array_agg(name order by created_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as games,
  max(score) as best,
  max(created_at) as last_at
from uwu2048_leaderboard
group by lower(name);

-- Adds a finished game under a name the API has already validated. The score
-- is read from the game, never taken from the caller. Returns the name's place
-- on both boards.
create or replace function uwu2048_submit(p_game_id uuid, p_name text)
returns table (status text, best_score int, rank bigint, total bigint, games int, total_rank bigint)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game uwu2048_games%rowtype;
  v_best int;
  v_best_at timestamptz;
  v_total bigint;
  v_games int;
begin
  select * into v_game from uwu2048_games where id = p_game_id for update;

  if not found then
    return query select 'not_found'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.finished_at is null then
    return query select 'unfinished'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.score <= 0 then
    return query select 'no_score'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.submitted then
    return query select 'already_submitted'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.finished_at < now() - interval '1 hour' then
    return query select 'expired'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  update uwu2048_games set submitted = true where id = p_game_id;
  insert into uwu2048_leaderboard (name, score, top_tile, game_id)
  values (p_name, v_game.score, v_game.top_tile, p_game_id);

  select l.score, l.created_at into v_best, v_best_at
  from uwu2048_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.score desc, l.created_at asc
  limit 1;

  select sum(l.score)::bigint, count(*)::int into v_total, v_games
  from uwu2048_leaderboard l
  where lower(l.name) = lower(p_name);

  return query
  select
    'ok'::text,
    v_best,
    (
      select count(*) + 1
      from uwu2048_leaderboard_best b
      where b.score > v_best or (b.score = v_best and b.created_at < v_best_at)
    ),
    v_total,
    v_games,
    (
      select count(*) + 1
      from uwu2048_leaderboard_total t
      where lower(t.name) <> lower(p_name)
        and (
          t.total > v_total
          or (t.total = v_total and t.games < v_games)
          -- This name's total was only just reached, so an equal one got there first.
          or (t.total = v_total and t.games = v_games)
        )
    );
end;
$$;

-- Housekeeping, called now and then by /api/game/new: games nobody added to
-- the leaderboard, once they are past any use. A game can be played over a
-- week (the page saves it), so eight days is the soonest one is.
create or replace function uwu2048_prune()
returns void
language sql
volatile
as $$
  delete from uwu2048_games g
  where g.started_at < now() - interval '8 days'
    and not g.submitted
    and not exists (select 1 from uwu2048_leaderboard l where l.game_id = g.id);
$$;

-- Service role only.
revoke all on function uwu2048_submit(uuid, text) from public, anon, authenticated;
revoke all on function uwu2048_prune() from public, anon, authenticated;
grant execute on function uwu2048_submit(uuid, text) to service_role;
grant execute on function uwu2048_prune() to service_role;
