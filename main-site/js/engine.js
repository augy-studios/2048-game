// The rules of 2048, with no page attached. The browser plays with this file
// and /api/game/finish replays finished games with the same file, so a score is
// only ever worked out one way.
//
// Where each new tile lands comes from a seeded generator. A ranked game's seed
// comes from the server, so replaying its moves gives the one board and score
// that game could have had; nobody gets to choose their own tiles.
//
// Anything here that changes how a game plays out, the odds, the generator,
// the order of spawns, must bump RULES_VERSION. The server refuses games played
// under a different version rather than scoring them wrongly.

export const RULES_VERSION = 1;

export const SIZE = 4;
export const CELLS = SIZE * SIZE;
export const WIN_TILE = 2048;
export const FOUR_CHANCE = 0.1;
export const DIRECTIONS = ["U", "D", "L", "R"];

// Pace. The page notes the time every MARK_EVERY moves, and the server refuses
// a game where any stretch between two notes went faster than
// MAX_MOVES_PER_SECOND. Well past a quick human, and slower than autoplay,
// which is what it is for. Not part of RULES_VERSION: it changes what gets
// refused, never a board or a score.
export const MARK_EVERY = 50;
export const MAX_MOVES_PER_SECOND = 10;

/* ---- seeded generator: cyrb128 to seed sfc32 ---- */

function hashSeed(text) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 | 0, h2 | 0, h3 | 0, h4 | 0];
}

// A float in [0, 1). Mutates the four words in `s`.
function nextRandom(s) {
  const t = (((s[0] + s[1]) | 0) + s[3]) | 0;
  s[3] = (s[3] + 1) | 0;
  s[0] = s[1] ^ (s[1] >>> 9);
  s[1] = (s[2] + (s[2] << 3)) | 0;
  s[2] = (s[2] << 21) | (s[2] >>> 11);
  s[2] = (s[2] + t) | 0;
  return (t >>> 0) / 4294967296;
}

function createRng(seed) {
  const s = hashSeed(String(seed));
  // The first outputs of a freshly seeded sfc32 are poorly mixed.
  for (let i = 0; i < 15; i++) nextRandom(s);
  return s;
}

/* ---- the board ---- */

// Cell indexes along one row or column, in the order tiles travel towards:
// the first entry is the edge the move pushes against.
function lineCells(dir, k) {
  const cells = [];
  for (let j = 0; j < SIZE; j++) {
    const step = dir === "L" || dir === "U" ? j : SIZE - 1 - j;
    cells.push(dir === "L" || dir === "R" ? k * SIZE + step : step * SIZE + k);
  }
  return cells;
}

// A new tile in a random empty cell: a 2, or a 4 one time in ten.
function spawn(game) {
  const empty = [];
  for (let i = 0; i < CELLS; i++) if (game.board[i] === 0) empty.push(i);
  if (!empty.length) return null;
  const at = empty[Math.floor(nextRandom(game.rng) * empty.length)];
  const value = nextRandom(game.rng) < FOUR_CHANCE ? 4 : 2;
  game.board[at] = value;
  return { at, value };
}

// A new game: an empty board and two tiles.
export function newGame(seed) {
  const game = { seed: String(seed), board: new Array(CELLS).fill(0), score: 0, moves: "", rng: createRng(seed) };
  game.spawned = [spawn(game), spawn(game)];
  return game;
}

// Slides a board one way without touching any game: no tile appears and no
// randomness is used, so autoplay can look ahead with it. Returns null when
// nothing would move, otherwise
//
//   board    the board after the slide
//   slides   [{ from, to, value, merged }]  every tile, merged: true for the
//                                           second of a pair joining the first
//   gained   points from this slide's merges
export function slide(board, dir) {
  if (!DIRECTIONS.includes(dir)) return null;

  const next = new Array(CELLS).fill(0);
  const slides = [];
  let gained = 0;

  for (let k = 0; k < SIZE; k++) {
    const cells = lineCells(dir, k);
    let place = 0; // where the next unmerged tile goes
    let open = -1; // the last tile placed, while it can still take a merge

    for (const from of cells) {
      const value = board[from];
      if (!value) continue;

      if (open >= 0 && next[cells[open]] === value) {
        next[cells[open]] = value * 2;
        gained += value * 2;
        slides.push({ from, to: cells[open], value, merged: true });
        // A merged tile does not merge again in the same move.
        open = -1;
      } else {
        next[cells[place]] = value;
        slides.push({ from, to: cells[place], value, merged: false });
        open = place;
        place++;
      }
    }
  }

  if (!slides.some((s) => s.from !== s.to)) return null;
  return { board: next, slides, gained };
}

// Plays one move. Returns null when nothing would move, which is not a turn:
// no tile appears and the move is not recorded. Otherwise the game is updated,
// and the result is slide()'s plus `spawned`, { at, value }, the tile that
// appeared afterwards.
export function move(game, dir) {
  const result = slide(game.board, dir);
  if (!result) return null;

  game.board = result.board;
  game.score += result.gained;
  game.moves += dir;
  result.spawned = spawn(game);
  return result;
}

// Whether any move would change the board.
export function canMove(board) {
  for (let i = 0; i < CELLS; i++) {
    if (!board[i]) return true;
    const col = i % SIZE;
    if (col < SIZE - 1 && board[i] === board[i + 1]) return true;
    if (i + SIZE < CELLS && board[i] === board[i + SIZE]) return true;
  }
  return false;
}

export function topTile(board) {
  return Math.max(...board);
}

// Plays a whole game again from its seed and its moves. Returns the game, or
// null when a move is not a direction or would not have moved anything, which
// no copy of this page ever records.
export function replay(seed, moves) {
  const game = newGame(seed);
  for (const dir of moves) {
    if (!move(game, dir)) return null;
  }
  return game;
}

// The numbers a finished game is ranked by. The server compares these with
// its own replay, field by field.
export function statsOf(game) {
  return { score: game.score, top_tile: topTile(game.board), moves: game.moves.length };
}
