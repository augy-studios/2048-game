# main-site

The 2048 Game PWA and its leaderboard API, one Vercel project. Plain HTML,
CSS and ES modules; no build step.

## Files

| Path | What it does |
| --- | --- |
| `index.html` | The page: the board, the end of game screen, and the leaderboard, settings, theme and new game dialogs. |
| `style.css` | The uwuapps theme (copied from `uwuapps-theme.md` unchanged), then the game. |
| `sw.js` | Offline support. Precaches the whole page; the update bar asks before a new version takes over. |
| `js/engine.js` | The rules: sliding, merging, the seeded tile generator, replaying a game. Shared with the API, so a score is only ever worked out one way. |
| `js/game.js` | The board on the page: drawing and animation, keys and swipes, the win and end screens, and saving the game in progress. |
| `js/ranked.js` | Asks for a seed as a game starts, and sends the moves when it ends. Runs the name form. |
| `js/autoplay.js`, `js/autoplay-worker.js` | An expectimax player that keeps the highest tile in the top left, run off the page's thread. |
| `js/leaderboard.js`, `js/settings.js` | The leaderboard and settings dialogs. |
| `js/theme.js`, `js/icons.js`, `js/ui.js` | The theme system, inline SVG icons, and modal helpers, as in `uwuapps-theme.md`. |
| `js/update-bar.js` | Registers the service worker and runs the update bar, as in `update-bar-spec.md`. |
| `js/app.js` | Wires it all together. |
| `api/` | Vercel functions. `api/_lib/` is not routed. |

Local storage keys all start `uwu2048.`: the theme, the settings, the game in
progress, the best score, and a random client key that ties this browser to
its own games.

## Playing

Standard 2048: a new tile after every move that moves something, a 2 nine
times in ten and otherwise a 4. Reaching 2048 offers to keep going or end the
game there. The game in progress is saved after every move, so a reload, a
closed tab or the update bar's Reload picks up where it was.

Swipes are read on the board only, which has `touch-action: none`, and the
page sets `overscroll-behavior: none`, so a swipe never scrolls, pulls to
refresh or navigates back.

## API

All JSON. `client_key` is the random id from local storage; a game is only
visible to the key that started it.

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/game/new` | `client_key, rules` | `game_id, seed, started_at` |
| `POST /api/game/finish` | `game_id, client_key, rules, score, top_tile, log, marks` | `game_id, score, top_tile, moves` |
| `POST /api/leaderboard/submit` | `game_id, name` | `name, rank, best_score, total, games, total_rank` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?board=best` (default) or `?board=total` | `board, entries`, cached 30 s |

Errors are `{ "error": code, "message"? }`: `400` bad input or an out of date
copy of the game (`outdated`), `404` no such game, `409` already finished or
submitted, `410` too old, `422` a game that does not check out
(`implausible`).

### Anti-cheat

The game runs in the browser, so a finished game is a claim. `finish` checks
it (`api/_lib/check.js`):

- **Seeded tiles.** `new` hands out a random seed, and every tile's cell and
  value come from it. `log` is the moves as a string of `U D L R`; the server
  replays them from the seed and gets the one board and score they lead to. A
  claimed score or top tile that differs is refused, and nobody can choose
  where their tiles land.
- **Real moves only.** A move that would not have moved anything is never
  recorded by the page, so one in the log is refused.
- **An ended game.** No moves left, or 2048 reached and the player chose to
  stop.
- **Pace.** The page notes the time every 50 moves (`marks`). No 50 may take
  under 5 seconds, and the whole game may not have more moves than 10 a second
  allows since `new`, by the server's clock.

A game is finished once, `submit` reads its score from the game row and never
from the request, and a game goes on the board once, within an hour of
finishing. A game started offline, or while the API could not be reached, has
no seed from the server and plays unranked. It cannot tell a person from a
script that plays at human speed.

### Leaderboards

Two boards over the same submissions, one row per name, names compared
case-insensitively and checked by `api/_lib/names.js` (shared with the other
uwuapps games):

| Board | Entries | Ranked by |
| --- | --- | --- |
| `best` | `{ rank, name, score, top_tile }` | the name's single best game; ties to whoever got it first |
| `total` | `{ rank, name, total, games }` | every submitted game added up; ties to fewer games, then whoever got there first |

## Running locally

`vercel dev` from this directory, with a `.env` copied from `.env.example`.
Serving the folder with any static server works too, and games then play
unranked because `/api/` is missing.

Note: the `/api` folder is Vercel serverless functions. They import
`js/engine.js`, which Vercel bundles with them.
