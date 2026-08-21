'use strict';

const crypto = require('crypto');
const {
  createGame,
  resolveBlackPlayerId,
  placeStone,
  toPublicGame,
  applyTimeoutLoss,
  pauseTurnClock,
  resumeTurnClock,
  BLACK,
  WHITE,
} = require('./game');
const { ErrorCode } = require('./protocol');

const RECONNECT_GRACE_MS = 60_000;
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class RoomManager {
  constructor() {
    /** @type {Map<string, any>} */
    this.rooms = new Map();
    /** @type {Map<string, string>} playerId -> roomId */
    this.playerRoom = new Map();
  }

  generateRoomId() {
    for (let attempt = 0; attempt < 20; attempt++) {
      let id = '';
      const bytes = crypto.randomBytes(6);
      for (let i = 0; i < 6; i++) {
        id += ROOM_ID_ALPHABET[bytes[i] % ROOM_ID_ALPHABET.length];
      }
      if (!this.rooms.has(id)) return id;
    }
    throw new Error('无法生成房间号');
  }

  createRoom(playerId, displayName, ws) {
    if (this.playerRoom.has(playerId)) {
      return { ok: false, code: ErrorCode.ALREADY_IN_ROOM, message: '你已在房间中' };
    }

    const roomId = this.generateRoomId();
    const room = {
      id: roomId,
      hostId: playerId,
      players: new Map(),
      game: null,
      status: 'waiting',
      rematchReady: new Map(),
      leaveRequestFrom: null,
      disconnected: new Map(),
      disconnectTimers: new Map(),
      turnTimer: null,
      score: { wins: new Map(), draws: 0 },
      lanShareBase: null,
    };

    room.players.set(playerId, {
      id: playerId,
      name: sanitizeName(displayName),
      ws,
      role: 'host',
      connected: true,
    });

    this.rooms.set(roomId, room);
    this.playerRoom.set(playerId, roomId);
    return { ok: true, room };
  }

  joinRoom(roomId, playerId, displayName, ws) {
    const id = String(roomId || '').trim().toUpperCase();
    const room = this.rooms.get(id);
    if (!room) {
      return { ok: false, code: ErrorCode.ROOM_NOT_FOUND, message: '房间不存在' };
    }

    if (this.playerRoom.has(playerId) && this.playerRoom.get(playerId) !== id) {
      return { ok: false, code: ErrorCode.ALREADY_IN_ROOM, message: '你已在其他房间中' };
    }

    const existing = room.players.get(playerId);
    if (existing) {
      return this.reconnectPlayer(playerId, ws);
    }

    if (room.players.size >= 2) {
      return { ok: false, code: ErrorCode.ROOM_FULL, message: '房间已满' };
    }

    room.players.set(playerId, {
      id: playerId,
      name: sanitizeName(displayName),
      ws,
      role: 'guest',
      connected: true,
    });
    this.playerRoom.set(playerId, id);
    this.clearDisconnect(room, playerId);
    this.tryStartGame(room);
    return { ok: true, room };
  }

  reconnectPlayer(playerId, ws) {
    const roomId = this.playerRoom.get(playerId);
    if (!roomId) {
      return { ok: false, code: ErrorCode.ROOM_NOT_FOUND, message: '不在任何房间中' };
    }
    const room = this.rooms.get(roomId);
    if (!room) {
      this.playerRoom.delete(playerId);
      return { ok: false, code: ErrorCode.ROOM_NOT_FOUND, message: '房间不存在' };
    }

    const player = room.players.get(playerId);
    if (!player) {
      this.playerRoom.delete(playerId);
      return { ok: false, code: ErrorCode.ROOM_NOT_FOUND, message: '座位已失效' };
    }

    player.ws = ws;
    player.connected = true;
    this.clearDisconnect(room, playerId);

    if (room.status === 'paused' && this.allConnected(room) && room.game && room.game.winner === null) {
      room.status = 'playing';
      room.game = resumeTurnClock(room.game);
      this.scheduleTurnTimer(room);
    } else if (room.status === 'waiting' && room.players.size === 2 && !room.game) {
      this.tryStartGame(room);
    }

    return { ok: true, room };
  }

  tryStartGame(room) {
    if (room.players.size !== 2) return;
    if (!this.allConnected(room)) return;
    if (room.game && room.status !== 'waiting') return;

    const playerIds = [...room.players.keys()];
    const blackId = resolveBlackPlayerId({ hostId: room.hostId, players: playerIds }, null);
    const whiteId = playerIds.find((id) => id !== blackId);
    room.game = createGame(blackId, whiteId);
    room.status = 'playing';
    room.rematchReady = new Map();
    room.leaveRequestFrom = null;
    this.scheduleTurnTimer(room);
  }

  needsLeaveConsent(room) {
    return (
      (room.status === 'playing' || room.status === 'paused') &&
      room.players.size === 2 &&
      this.allConnected(room)
    );
  }

  place(playerId, x, y) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '不在房间中' };
    }
    if (room.status !== 'playing' || !room.game) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '当前不可落子' };
    }
    if (!this.allConnected(room)) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '对手已断开，请稍候' };
    }

    const result = placeStone(room.game, playerId, x, y);
    if (!result.ok) return result;

    room.game = result.game;
    if (room.game.winner !== null) {
      room.status = 'finished';
      room.rematchReady = new Map();
      room.leaveRequestFrom = null;
      this.clearTurnTimer(room);
      this.recordGameResult(room);
    } else {
      this.scheduleTurnTimer(room);
    }
    return { ok: true, room };
  }

  rematchReady(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '不在房间中' };
    }
    if (room.status !== 'finished' || !room.game) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '对局未结束' };
    }
    if (room.players.size !== 2 || !this.allConnected(room)) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '双方需在线才能再来一局' };
    }

    room.rematchReady.set(playerId, true);

    const ids = [...room.players.keys()];
    if (ids.every((id) => room.rematchReady.get(id))) {
      this.startRematch(room);
    }
    return { ok: true, room };
  }

  rematchCancel(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '不在房间中' };
    }
    if (room.status !== 'finished') {
      return { ok: false, code: ErrorCode.NOT_READY, message: '对局未结束' };
    }
    room.rematchReady.set(playerId, false);
    return { ok: true, room };
  }

  startRematch(room) {
    const playerIds = [...room.players.keys()];
    const prev = room.game;
    let previousResult = null;
    if (prev.winner === 0) {
      previousResult = { draw: true };
    } else if (prev.winner === BLACK) {
      previousResult = { winnerPlayerId: prev.blackPlayerId };
    } else if (prev.winner === WHITE) {
      previousResult = { winnerPlayerId: prev.whitePlayerId };
    }

    const blackId = resolveBlackPlayerId(
      { hostId: room.hostId, players: playerIds },
      previousResult,
      prev.blackPlayerId,
    );
    const whiteId = playerIds.find((id) => id !== blackId);
    room.game = createGame(blackId, whiteId);
    room.status = 'playing';
    room.rematchReady = new Map();
    room.leaveRequestFrom = null;
    this.scheduleTurnTimer(room);
  }

  scheduleTurnTimer(room) {
    this.clearTurnTimer(room);
    if (room.status !== 'playing' || !room.game || room.game.winner !== null || !room.game.turnDeadline) {
      return;
    }
    const delay = Math.max(0, room.game.turnDeadline - Date.now());
    room.turnTimer = setTimeout(() => {
      this.onTurnTimeout(room.id);
    }, delay);
  }

  clearTurnTimer(room) {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  }

  onTurnTimeout(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'playing' || !room.game || room.game.winner !== null) return;
    if (!room.game.turnDeadline || Date.now() < room.game.turnDeadline - 20) return;

    room.game = applyTimeoutLoss(room.game);
    room.status = 'finished';
    room.rematchReady = new Map();
    room.leaveRequestFrom = null;
    this.clearTurnTimer(room);
    this.recordGameResult(room);

    if (typeof this.onRoomChanged === 'function') {
      this.onRoomChanged({ ok: true, room, dissolved: false });
    }
  }

  recordGameResult(room) {
    const game = room.game;
    if (!game || game.winner === null || game.scoreRecorded) return;
    game.scoreRecorded = true;
    if (!room.score) {
      room.score = { wins: new Map(), draws: 0 };
    }
    if (game.winner === 0) {
      room.score.draws += 1;
      return;
    }
    const winnerId = game.winner === BLACK ? game.blackPlayerId : game.whitePlayerId;
    room.score.wins.set(winnerId, (room.score.wins.get(winnerId) || 0) + 1);
  }

  requestLeave(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '不在房间中' };
    }
    if (!this.needsLeaveConsent(room)) {
      const result = this.leave(playerId);
      return { ...result, leftImmediately: true };
    }
    if (room.leaveRequestFrom && room.leaveRequestFrom !== playerId) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '对方已发起离开申请，请先同意或拒绝' };
    }
    room.leaveRequestFrom = playerId;
    return { ok: true, room, dissolved: false, leftImmediately: false };
  }

  acceptLeave(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '不在房间中' };
    }
    if (!room.leaveRequestFrom) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '当前没有离开申请' };
    }
    if (room.leaveRequestFrom === playerId) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '不能同意自己的离开申请' };
    }
    return this.dissolveAll(room);
  }

  rejectLeave(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '不在房间中' };
    }
    if (!room.leaveRequestFrom) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '当前没有离开申请' };
    }
    if (room.leaveRequestFrom === playerId) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '请使用取消申请' };
    }
    room.leaveRequestFrom = null;
    return { ok: true, room };
  }

  cancelLeave(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '不在房间中' };
    }
    if (room.leaveRequestFrom !== playerId) {
      return { ok: false, code: ErrorCode.NOT_READY, message: '你没有待处理的离开申请' };
    }
    room.leaveRequestFrom = null;
    return { ok: true, room };
  }

  dissolveAll(room) {
    const everyone = [...room.players.values()].map((p) => ({ id: p.id, ws: p.ws }));
    const roomId = room.id;
    this.dissolveRoom(roomId);
    return { ok: true, room: null, dissolved: true, roomId, others: everyone };
  }

  leave(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return { ok: true, room: null, dissolved: false, others: [] };

    if (this.needsLeaveConsent(room)) {
      return {
        ok: false,
        code: ErrorCode.LEAVE_NEEDS_CONSENT,
        message: '对局进行中，离开需对方同意',
      };
    }

    this.clearDisconnect(room, playerId);
    this.clearTurnTimer(room);

    const others = [...room.players.values()]
      .filter((p) => p.id !== playerId)
      .map((p) => ({ id: p.id, ws: p.ws }));

    room.players.delete(playerId);
    this.playerRoom.delete(playerId);
    room.leaveRequestFrom = null;

    if (playerId === room.hostId || room.players.size === 0) {
      const roomId = room.id;
      this.dissolveRoom(roomId);
      return { ok: true, room: null, dissolved: true, roomId, others };
    }

    room.game = null;
    room.status = 'waiting';
    room.rematchReady = new Map();
    room.leaveRequestFrom = null;
    return { ok: true, room, dissolved: false, others };
  }

  handleDisconnect(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return { ok: true, room: null };

    const player = room.players.get(playerId);
    if (!player) return { ok: true, room: null };

    player.connected = false;
    player.ws = null;
    room.disconnected.set(playerId, Date.now());
    room.leaveRequestFrom = null;

    if (room.status === 'playing') {
      room.status = 'paused';
      if (room.game) {
        room.game = pauseTurnClock(room.game);
      }
      this.clearTurnTimer(room);
    }

    const timer = setTimeout(() => {
      this.onReconnectTimeout(playerId);
    }, RECONNECT_GRACE_MS);
    room.disconnectTimers.set(playerId, timer);

    return { ok: true, room };
  }

  onReconnectTimeout(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return;

    const player = room.players.get(playerId);
    if (!player || player.connected) return;

    const result = this.leave(playerId);
    if (typeof this.onRoomChanged === 'function') {
      this.onRoomChanged(result);
    }
  }

  clearDisconnect(room, playerId) {
    const timer = room.disconnectTimers.get(playerId);
    if (timer) clearTimeout(timer);
    room.disconnectTimers.delete(playerId);
    room.disconnected.delete(playerId);
  }

  dissolveRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.clearTurnTimer(room);
    for (const timer of room.disconnectTimers.values()) clearTimeout(timer);
    for (const pid of room.players.keys()) {
      this.playerRoom.delete(pid);
    }
    this.rooms.delete(roomId);
  }

  getRoomByPlayer(playerId) {
    const roomId = this.playerRoom.get(playerId);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  allConnected(room) {
    for (const p of room.players.values()) {
      if (!p.connected) return false;
    }
    return true;
  }

  buildSnapshot(room, viewerId, shareBase) {
    const players = [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      connected: p.connected,
    }));

    const you = room.players.get(viewerId);
    let color = null;
    if (room.game) {
      if (room.game.blackPlayerId === viewerId) color = 'black';
      else if (room.game.whitePlayerId === viewerId) color = 'white';
    }

    const rematchReady = {};
    for (const pid of room.players.keys()) {
      rematchReady[pid] = !!room.rematchReady.get(pid);
    }

    return {
      roomId: room.id,
      status: room.status,
      hostId: room.hostId,
      players,
      rematchReady,
      leaveRequestFrom: room.leaveRequestFrom,
      shareUrl: `${shareBase}/?room=${room.id}`,
      scoreboard: {
        draws: room.score ? room.score.draws : 0,
        players: players.map((p) => ({
          id: p.id,
          name: p.name,
          wins: room.score ? room.score.wins.get(p.id) || 0 : 0,
        })),
      },
      youAre: {
        playerId: viewerId,
        color,
        isHost: you ? you.role === 'host' : false,
        rematchReady: !!room.rematchReady.get(viewerId),
      },
      game: room.game ? toPublicGame(room.game) : null,
    };
  }
}

function sanitizeName(name) {
  const s = String(name || '').trim().slice(0, 16);
  return s || '玩家';
}

module.exports = { RoomManager, RECONNECT_GRACE_MS };
