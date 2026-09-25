// The leaderboard API. The game runs here; the server hands out seeds, replays
// finished games, and ranks them.

const KEY_STORAGE = "uwu2048.clientKey";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// A random id tying this browser's requests to its own games. Not an
// identity: it grants nothing and is never shown.
function makeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let memoryKey = null;

export function clientKey() {
  try {
    let key = localStorage.getItem(KEY_STORAGE);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key ?? "")) {
      key = makeKey();
      localStorage.setItem(KEY_STORAGE, key);
    }
    return key;
  } catch {
    // Storage blocked: games still rank for this page view.
    memoryKey ??= makeKey();
    return memoryKey;
  }
}

async function call(method, path, body, timeoutMs) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline", "The leaderboard needs a connection.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // An HTML error page from the platform, not the API.
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error ?? "server", data?.message);
  }
  return data;
}

export const api = {
  // Short timeout: a new game waits on this, and offline it plays unranked.
  newGame: (rules) => call("POST", "/api/game/new", { client_key: clientKey(), rules }, 4000),
  finish: (gameId, details) => call("POST", "/api/game/finish", { game_id: gameId, client_key: clientKey(), ...details }),
  checkName: (name) => call("POST", "/api/leaderboard/name", { name }),
  submit: (gameId, name) => call("POST", "/api/leaderboard/submit", { game_id: gameId, name }),
  leaderboard: (board) => call("GET", `/api/leaderboard?board=${encodeURIComponent(board)}`),
};
