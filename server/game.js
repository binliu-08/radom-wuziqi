'use strict';

const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const TURN_SECONDS = 20;
const TURN_MS = TURN_SECONDS * 1000;

/**
 * @typedef {{
 *   board: number[][],
 *   blackPlayerId: string,
 *   whitePlayerId: string,
 *   current: 1 | 2,
 *   winner: null | 0 | 1 | 2,
 *   moveCount: number,
 *   lastMove: null | { x: number, y: number },
 *   turnDeadline: number | null,
 *   turnRemainingMs: number | null,
 *   winReason: null | 'timeout',
 * }} GameState
 */

/**
 * @param {string} blackPlayerId
 * @param {string} whitePlayerId
 * @returns {GameState}
 */
function createGame(blackPlayerId, whitePlayerId) {
  return {
    board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY)),
    blackPlayerId,
    whitePlayerId,
    current: BLACK,
    winner: null,
    moveCount: 0,
    lastMove: null,
    turnDeadline: Date.now() + TURN_MS,
    turnRemainingMs: null,
    winReason: null,
  };
}

/**
 * @param {{ hostId: string, players: string[] }} room
 * @param {null | { draw: true } | { winnerPlayerId: string }} previousResult
 * @param {string | null} previousBlackPlayerId
 * @returns {string}
 */
function resolveBlackPlayerId(room, previousResult, previousBlackPlayerId = null) {
  if (previousResult == null) {
    return room.hostId;
  }

  if (previousResult.draw) {
    return previousBlackPlayerId ?? room.hostId;
  }

  const winnerId = previousResult.winnerPlayerId;
  const loserId = room.players.find((id) => id !== winnerId);
  return loserId ?? room.hostId;
}

/**
 * @param {GameState} game
 * @param {string} playerId
 * @param {number} x
 * @param {number} y
 * @returns {{ ok: true, game: GameState } | { ok: false, code: string, message: string }}
 */
function placeStone(game, playerId, x, y) {
  if (game.winner !== null) {
    return { ok: false, code: 'NOT_READY', message: '对局已结束' };
  }

  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) {
    return { ok: false, code: 'INVALID_MOVE', message: '坐标无效' };
  }

  const expectedPlayerId = game.current === BLACK ? game.blackPlayerId : game.whitePlayerId;
  if (playerId !== expectedPlayerId) {
    return { ok: false, code: 'NOT_YOUR_TURN', message: '还没轮到你' };
  }

  if (game.board[y][x] !== EMPTY) {
    return { ok: false, code: 'INVALID_MOVE', message: '该位置已有棋子' };
  }

  const next = {
    ...game,
    board: game.board.map((row) => row.slice()),
    moveCount: game.moveCount + 1,
    lastMove: { x, y },
    turnRemainingMs: null,
    winReason: null,
  };
  next.board[y][x] = game.current;

  if (hasFiveInARow(next.board, x, y, game.current)) {
    next.winner = game.current;
    next.turnDeadline = null;
    return { ok: true, game: next };
  }

  if (next.moveCount >= BOARD_SIZE * BOARD_SIZE) {
    next.winner = 0;
    next.turnDeadline = null;
    return { ok: true, game: next };
  }

  next.current = game.current === BLACK ? WHITE : BLACK;
  next.turnDeadline = Date.now() + TURN_MS;
  return { ok: true, game: next };
}

/**
 * 当前行棋方超时，判对方胜
 * @param {GameState} game
 * @returns {GameState}
 */
function applyTimeoutLoss(game) {
  if (game.winner !== null) return game;
  const winner = game.current === BLACK ? WHITE : BLACK;
  return {
    ...game,
    winner,
    turnDeadline: null,
    turnRemainingMs: null,
    winReason: 'timeout',
  };
}

function pauseTurnClock(game) {
  if (!game || game.winner !== null || !game.turnDeadline) {
    return { ...game, turnDeadline: null };
  }
  const remaining = Math.max(0, game.turnDeadline - Date.now());
  return {
    ...game,
    turnDeadline: null,
    turnRemainingMs: remaining,
  };
}

function resumeTurnClock(game) {
  if (!game || game.winner !== null) return game;
  const remaining = game.turnRemainingMs != null ? game.turnRemainingMs : TURN_MS;
  return {
    ...game,
    turnDeadline: Date.now() + Math.max(0, remaining),
    turnRemainingMs: null,
  };
}

/**
 * @param {number[][]} board
 * @param {number} x
 * @param {number} y
 * @param {number} color
 */
function hasFiveInARow(board, x, y, color) {
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];

  for (const [dx, dy] of dirs) {
    let count = 1;
    count += countDirection(board, x, y, dx, dy, color);
    count += countDirection(board, x, y, -dx, -dy, color);
    if (count >= 5) return true;
  }
  return false;
}

function countDirection(board, x, y, dx, dy, color) {
  let n = 0;
  let cx = x + dx;
  let cy = y + dy;
  while (cx >= 0 && cy >= 0 && cx < BOARD_SIZE && cy < BOARD_SIZE && board[cy][cx] === color) {
    n += 1;
    cx += dx;
    cy += dy;
  }
  return n;
}

/**
 * @param {GameState} game
 */
function toPublicGame(game) {
  return {
    board: game.board,
    blackPlayerId: game.blackPlayerId,
    whitePlayerId: game.whitePlayerId,
    current: game.current,
    winner: game.winner,
    moveCount: game.moveCount,
    lastMove: game.lastMove,
    turnDeadline: game.turnDeadline,
    turnSeconds: TURN_SECONDS,
    winReason: game.winReason,
  };
}

module.exports = {
  BOARD_SIZE,
  EMPTY,
  BLACK,
  WHITE,
  TURN_SECONDS,
  TURN_MS,
  createGame,
  resolveBlackPlayerId,
  placeStone,
  applyTimeoutLoss,
  pauseTurnClock,
  resumeTurnClock,
  hasFiveInARow,
  toPublicGame,
};
