// Autoplay's choice of move. Secret on purpose: F2 in js/game.js, and not in
// any hint on the page. Runs in js/autoplay-worker.js so a deep search never
// holds up the page.
//
// The corner strategy: keep the highest tile in the top left for as long as
// possible. Only when no move can keep it there does a move take it away,
// and the very next move tries to bring it straight back.
//
// Between the moves that keep the corner, an expectimax search picks the
// best: every move, then every tile that could appear, as deep as the time
// allows, scoring the boards it reaches by how well they are laid out (the
// heuristic from nneonneo's 2048 AI: empty cells, merges, monotone rows and
// columns). The corner rule above is what anchors play in the top left; the
// heuristic itself lets rows and columns run either way, which measured
// stronger than one that also insists columns fall from the top.
//
// Boards here are four 20 bit rows, five bits a cell holding the tile's power
// of two (0 empty, 1 for 2, 16 for 65536), cell 0 in the low bits. Every
// possible row's slides and score are worked out once, in tables.

import { CELLS, DIRECTIONS } from "./engine.js";

const ROWS = 1 << 20;
const CELL_BITS = 5;
const CELL_MASK = 31;

/* ---- tables ---- */

const LEFT = new Int32Array(ROWS);
const RIGHT = new Int32Array(ROWS);
const HEUR = new Float32Array(ROWS);

const LOST_PENALTY = 200000;
const MONOTONICITY_POWER = 4;
const MONOTONICITY_WEIGHT = 47;
const SUM_POWER = 3.5;
const SUM_WEIGHT = 11;
const MERGES_WEIGHT = 700;
const EMPTY_WEIGHT = 270;

function buildTables() {
  const sumPow = new Float64Array(32);
  const monoPow = new Float64Array(32);
  for (let r = 0; r < 32; r++) {
    sumPow[r] = r ** SUM_POWER;
    monoPow[r] = r ** MONOTONICITY_POWER;
  }

  const line = [0, 0, 0, 0];
  for (let row = 0; row < ROWS; row++) {
    for (let j = 0; j < 4; j++) line[j] = (row >> (CELL_BITS * j)) & CELL_MASK;

    let sum = 0;
    let empty = 0;
    let merges = 0;
    let prev = 0;
    let counter = 0;
    for (let j = 0; j < 4; j++) {
      const rank = line[j];
      sum += sumPow[rank];
      if (rank === 0) {
        empty++;
      } else {
        if (prev === rank) counter++;
        else if (counter > 0) {
          merges += 1 + counter;
          counter = 0;
        }
        prev = rank;
      }
    }
    if (counter > 0) merges += 1 + counter;

    // Falling towards cell 3, and rising towards it.
    let falling = 0;
    let rising = 0;
    for (let j = 1; j < 4; j++) {
      if (line[j - 1] > line[j]) falling += monoPow[line[j - 1]] - monoPow[line[j]];
      else rising += monoPow[line[j]] - monoPow[line[j - 1]];
    }
    // Either way round is fine, which is what lets the tiles snake back along
    // the second row.
    HEUR[row] =
      LOST_PENALTY + EMPTY_WEIGHT * empty + MERGES_WEIGHT * merges - SUM_WEIGHT * sum -
      MONOTONICITY_WEIGHT * Math.min(falling, rising);

    // The slide towards cell 0.
    const out = [0, 0, 0, 0];
    let place = 0;
    let open = false;
    for (let j = 0; j < 4; j++) {
      const rank = line[j];
      if (!rank) continue;
      if (open && out[place - 1] === rank && rank < CELL_MASK) {
        out[place - 1] = rank + 1;
        open = false;
      } else {
        out[place++] = rank;
        open = true;
      }
    }
    const left = out[0] | (out[1] << 5) | (out[2] << 10) | (out[3] << 15);
    LEFT[row] = left;

    // The slide towards cell 3 is the same slide on the reversed row.
    const reversed = line[3] | (line[2] << 5) | (line[1] << 10) | (line[0] << 15);
    const back = left;
    RIGHT[reversed] =
      ((back >> 15) & CELL_MASK) | (((back >> 10) & CELL_MASK) << 5) | (((back >> 5) & CELL_MASK) << 10) | ((back & CELL_MASK) << 15);
  }
}

buildTables();

/* ---- boards ---- */

// Columns of a board, written to T0..T3 to save allocating.
let T0 = 0;
let T1 = 0;
let T2 = 0;
let T3 = 0;

function transpose(a, b, c, d) {
  T0 = (a & 31) | ((b & 31) << 5) | ((c & 31) << 10) | ((d & 31) << 15);
  T1 = ((a >> 5) & 31) | (((b >> 5) & 31) << 5) | (((c >> 5) & 31) << 10) | (((d >> 5) & 31) << 15);
  T2 = ((a >> 10) & 31) | (((b >> 10) & 31) << 5) | (((c >> 10) & 31) << 10) | (((d >> 10) & 31) << 15);
  T3 = ((a >> 15) & 31) | (((b >> 15) & 31) << 5) | (((c >> 15) & 31) << 10) | (((d >> 15) & 31) << 15);
}

function heuristic(a, b, c, d) {
  transpose(a, b, c, d);
  return (
    HEUR[a] + HEUR[b] + HEUR[c] + HEUR[d] +
    HEUR[T0] + HEUR[T1] + HEUR[T2] + HEUR[T3]
  );
}

/* ---- search ---- */

// Branches less likely than this are scored where they stand.
const MIN_PROBABILITY = 0.0001;
// Levels searched past nneonneo's usual depth, time permitting.
const EXTRA_DEPTH = 3;
const FOUR_CHANCE = 0.1;

// A lossy cache of scored boards, cleared between moves by bumping `stamp`.
const CACHE_BITS = 18;
const CACHE_SIZE = 1 << CACHE_BITS;
const CACHE_DEPTH_LIMIT = 15;
const cacheA = new Int32Array(CACHE_SIZE);
const cacheB = new Int32Array(CACHE_SIZE);
const cacheC = new Int32Array(CACHE_SIZE);
const cacheD = new Int32Array(CACHE_SIZE);
const cacheDepth = new Int8Array(CACHE_SIZE);
const cacheStamp = new Int32Array(CACHE_SIZE);
const cacheValue = new Float64Array(CACHE_SIZE);
let stamp = 0;

let depthLimit = 1;
let deadline = Infinity;
let nodes = 0;
const OUT_OF_TIME = Symbol("out of time");

function slot(a, b, c, d) {
  let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d) ^ Math.imul(d, 0x27d4eb2f);
  h ^= h >>> 15;
  return h & (CACHE_SIZE - 1);
}

function chanceNode(a, b, c, d, probability, depth) {
  if (probability < MIN_PROBABILITY || depth >= depthLimit) return heuristic(a, b, c, d);

  if ((++nodes & 1023) === 0 && performance.now() > deadline) throw OUT_OF_TIME;

  let at = -1;
  if (depth < CACHE_DEPTH_LIMIT) {
    at = slot(a, b, c, d);
    if (
      cacheStamp[at] === stamp && cacheA[at] === a && cacheB[at] === b && cacheC[at] === c && cacheD[at] === d &&
      cacheDepth[at] <= depth
    ) {
      return cacheValue[at];
    }
  }

  let open = 0;
  for (let j = 0; j < 4; j++) {
    const shift = CELL_BITS * j;
    if (!((a >> shift) & 31)) open++;
    if (!((b >> shift) & 31)) open++;
    if (!((c >> shift) & 31)) open++;
    if (!((d >> shift) & 31)) open++;
  }
  const each = probability / open;
  const two = each * (1 - FOUR_CHANCE);
  const four = each * FOUR_CHANCE;

  let total = 0;
  for (let j = 0; j < 4; j++) {
    const shift = CELL_BITS * j;
    const t2 = 1 << shift;
    const t4 = 2 << shift;
    if (!((a >> shift) & 31)) {
      total += (1 - FOUR_CHANCE) * moveNode(a | t2, b, c, d, two, depth) + FOUR_CHANCE * moveNode(a | t4, b, c, d, four, depth);
    }
    if (!((b >> shift) & 31)) {
      total += (1 - FOUR_CHANCE) * moveNode(a, b | t2, c, d, two, depth) + FOUR_CHANCE * moveNode(a, b | t4, c, d, four, depth);
    }
    if (!((c >> shift) & 31)) {
      total += (1 - FOUR_CHANCE) * moveNode(a, b, c | t2, d, two, depth) + FOUR_CHANCE * moveNode(a, b, c | t4, d, four, depth);
    }
    if (!((d >> shift) & 31)) {
      total += (1 - FOUR_CHANCE) * moveNode(a, b, c, d | t2, two, depth) + FOUR_CHANCE * moveNode(a, b, c, d | t4, four, depth);
    }
  }
  const value = total / open;

  if (at >= 0) {
    cacheStamp[at] = stamp;
    cacheA[at] = a;
    cacheB[at] = b;
    cacheC[at] = c;
    cacheD[at] = d;
    cacheDepth[at] = depth;
    cacheValue[at] = value;
  }
  return value;
}

// The best any move does from here; 0, the worst, when there is none.
function moveNode(a, b, c, d, probability, depth) {
  let best = 0;
  const next = depth + 1;

  let w = LEFT[a], x = LEFT[b], y = LEFT[c], z = LEFT[d];
  if (w !== a || x !== b || y !== c || z !== d) best = Math.max(best, chanceNode(w, x, y, z, probability, next));

  w = RIGHT[a]; x = RIGHT[b]; y = RIGHT[c]; z = RIGHT[d];
  if (w !== a || x !== b || y !== c || z !== d) best = Math.max(best, chanceNode(w, x, y, z, probability, next));

  transpose(a, b, c, d);
  const c0 = T0, c1 = T1, c2 = T2, c3 = T3;

  w = LEFT[c0]; x = LEFT[c1]; y = LEFT[c2]; z = LEFT[c3];
  if (w !== c0 || x !== c1 || y !== c2 || z !== c3) {
    transpose(w, x, y, z);
    best = Math.max(best, chanceNode(T0, T1, T2, T3, probability, next));
  }

  w = RIGHT[c0]; x = RIGHT[c1]; y = RIGHT[c2]; z = RIGHT[c3];
  if (w !== c0 || x !== c1 || y !== c2 || z !== c3) {
    transpose(w, x, y, z);
    best = Math.max(best, chanceNode(T0, T1, T2, T3, probability, next));
  }

  return best;
}

/* ---- the move ---- */

function encode(board) {
  const rows = [0, 0, 0, 0];
  for (let i = 0; i < CELLS; i++) {
    const value = board[i];
    const rank = value ? Math.round(Math.log2(value)) : 0;
    rows[i >> 2] |= rank << (CELL_BITS * (i & 3));
  }
  return rows;
}

// The board after one move, as four rows, or null when it would not move.
function slideRows([a, b, c, d], dir) {
  let out;
  if (dir === "L") out = [LEFT[a], LEFT[b], LEFT[c], LEFT[d]];
  else if (dir === "R") out = [RIGHT[a], RIGHT[b], RIGHT[c], RIGHT[d]];
  else {
    transpose(a, b, c, d);
    const table = dir === "U" ? LEFT : RIGHT;
    const w = table[T0], x = table[T1], y = table[T2], z = table[T3];
    transpose(w, x, y, z);
    out = [T0, T1, T2, T3];
  }
  return out[0] === a && out[1] === b && out[2] === c && out[3] === d ? null : out;
}

function rankAt(rows, i) {
  return (rows[i >> 2] >> (CELL_BITS * (i & 3))) & CELL_MASK;
}

function highestRank(rows) {
  let high = 0;
  for (let i = 0; i < CELLS; i++) high = Math.max(high, rankAt(rows, i));
  return high;
}

function distinctTiles(rows) {
  const seen = new Set();
  for (let i = 0; i < CELLS; i++) {
    const rank = rankAt(rows, i);
    if (rank) seen.add(rank);
  }
  return seen.size;
}

// The move autoplay makes on this board, an engine board of 16 values, or
// null when there is none. It searches deeper while there is time, and always
// finishes at least one level, however short `budgetMs` is.
export function chooseMove(board, budgetMs = 50) {
  const rows = encode(board);
  const options = DIRECTIONS.map((dir) => ({ dir, rows: slideRows(rows, dir) })).filter((o) => o.rows);
  if (!options.length) return null;
  if (options.length === 1) return options[0].dir;

  // Moves that end with the highest tile in the corner. When the corner has
  // been lost, these are the moves that win it straight back.
  const cornered = options.filter((o) => rankAt(o.rows, 0) === highestRank(o.rows));
  const pool = cornered.length ? cornered : options;
  if (pool.length === 1) return pool[0].dir;

  // Deeper while the time lasts. An early, simple board is settled a few
  // levels down, and past that extra depth changes nothing but the wait.
  const target = Math.max(3, distinctTiles(rows) - 2) + EXTRA_DEPTH;
  let chosen = pool[0].dir;
  const stop = performance.now() + budgetMs;

  for (let depth = 1; depth <= target; depth++) {
    depthLimit = depth;
    deadline = depth === 1 ? Infinity : stop;
    stamp = (stamp + 1) | 0;
    try {
      let best = -Infinity;
      let bestDir = chosen;
      for (const option of pool) {
        const [a, b, c, d] = option.rows;
        const value = chanceNode(a, b, c, d, 1, 0) + 1e-6;
        if (value > best) {
          best = value;
          bestDir = option.dir;
        }
      }
      chosen = bestDir;
    } catch (cause) {
      if (cause !== OUT_OF_TIME) throw cause;
      break;
    }
    if (performance.now() > stop) break;
  }
  return chosen;
}
