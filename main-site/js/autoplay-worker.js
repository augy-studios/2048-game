// Autoplay's search, off the page's thread. js/game.js posts a board and a
// time budget, and gets back the move to make.

import { chooseMove } from "./autoplay.js";

self.addEventListener("message", (event) => {
  const { id, board, budget } = event.data;
  self.postMessage({ id, dir: chooseMove(board, budget) });
});
