# 2048 Game

2048 for phones and computers at [2048.uwuapps.org](https://2048.uwuapps.org/),
on the uwuapps theme. Swipe or use the arrow keys, pick up a game where you
left it, climb the best score and total points leaderboards, and keep playing
offline.

| Path | What it is |
| --- | --- |
| `main-site/` | The PWA and its leaderboard API, deployed on Vercel. See [main-site/README.md](main-site/README.md). |
| `migrations/` | SQL for the shared uwuapps Supabase project. |
| `scripts/check.mjs` | Checks to run before every deploy. |
| `uwuapps-theme.md`, `uwuapps-retrofit-time-mode.md`, `update-bar-spec.md` | The specs the site follows. |

## Setting up

1. **Supabase.** In the shared uwuapps project's SQL editor, run each file in
   `migrations/` once, in number order. Never edit a file once it has been
   run; every change is a new file with the next number. Every table is
   `uwu2048_` prefixed, with row level security on and no policies, so only the
   service role key can read or write.
2. **Vercel.** Root directory `main-site`. Set `SUPABASE_URL` and
   `SUPABASE_SERVICE_KEY` (see `main-site/.env.example`), and add the domain
   `2048.uwuapps.org`.

## Every deploy

1. Bump `VERSION` in `main-site/sw.js`. Without it nobody is offered the
   update, however much else changed.
2. Run `node scripts/check.mjs`. It fails if the service worker could take
   over without asking, a file is missing from the offline cache, the replay
   check stops matching the game, a tile's number drops under 4.5:1, or an em
   dash turns up.

If a change alters how games play out (odds, the seeded generator, the order
tiles appear in), bump `RULES_VERSION` in `main-site/js/engine.js` as well.
The server then refuses games from older cached copies instead of replaying
them wrongly.
