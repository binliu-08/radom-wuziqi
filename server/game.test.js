'use strict';

const assert = require('assert');
const {
  createGame,
  placeStone,
  resolveBlackPlayerId,
  hasFiveInARow,
  BLACK,
  WHITE,
} = require('./game');

function testWinHorizontal() {
  const game = createGame('a', 'b');
  let g = game;
  // Black places 5 in a row on y=7
  for (let x = 0; x < 4; x++) {
    let r = placeStone(g, 'a', x, 7);
    assert.ok(r.ok);
    g = r.game;
    r = placeStone(g, 'b', x, 8);
    assert.ok(r.ok);
    g = r.game;
  }
  const r = placeStone(g, 'a', 4, 7);
  assert.ok(r.ok);
  assert.strictEqual(r.game.winner, BLACK);
}

function testNotYourTurn() {
  const game = createGame('a', 'b');
  const r = placeStone(game, 'b', 0, 0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'NOT_YOUR_TURN');
}

function testResolveBlack() {
  assert.strictEqual(resolveBlackPlayerId({ hostId: 'host', players: ['host', 'guest'] }, null), 'host');
  assert.strictEqual(
    resolveBlackPlayerId({ hostId: 'host', players: ['host', 'guest'] }, { winnerPlayerId: 'host' }, 'host'),
    'guest',
  );
  assert.strictEqual(
    resolveBlackPlayerId({ hostId: 'host', players: ['host', 'guest'] }, { draw: true }, 'guest'),
    'guest',
  );
}

function testFiveHelper() {
  const board = Array.from({ length: 15 }, () => Array(15).fill(0));
  for (let i = 0; i < 5; i++) board[3][i] = BLACK;
  assert.ok(hasFiveInARow(board, 2, 3, BLACK));
}

testWinHorizontal();
testNotYourTurn();
testResolveBlack();
testFiveHelper();
console.log('game.test.js: all passed');
