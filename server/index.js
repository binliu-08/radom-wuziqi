'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./roomManager');
const { ClientMsg, ServerMsg, ErrorCode } = require('./protocol');

const PORT = Number(process.env.PORT) || 3000;
const rooms = new RoomManager();

rooms.onRoomChanged = (result) => {
  if (result.dissolved) {
    notifyDissolved(result.others || []);
  } else if (result.room) {
    broadcastRoom(result.room);
  }
};

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** @type {WeakMap<object, { playerId: string }>} */
const sockets = new WeakMap();

wss.on('connection', (ws, req) => {
  const playerId = crypto.randomUUID();
  sockets.set(ws, { playerId });
  send(ws, ServerMsg.WELCOME, { playerId });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, ServerMsg.ERROR, { code: ErrorCode.BAD_REQUEST, message: '消息格式错误' });
      return;
    }

    const type = msg && msg.type;
    const payload = (msg && msg.payload) || {};
    const meta = sockets.get(ws);
    if (!meta) return;

    try {
      handleMessage(ws, meta, type, payload, req);
    } catch (err) {
      console.error(err);
      send(ws, ServerMsg.ERROR, { code: ErrorCode.BAD_REQUEST, message: '服务器处理失败' });
    }
  });

  ws.on('close', () => {
    const meta = sockets.get(ws);
    if (!meta) return;
    const result = rooms.handleDisconnect(meta.playerId);
    if (result.room) {
      broadcastRoom(result.room);
    }
  });
});

function handleMessage(ws, meta, type, payload, req) {
  switch (type) {
    case ClientMsg.PING:
      send(ws, ServerMsg.PONG, {});
      return;

    case ClientMsg.CREATE_ROOM: {
      const result = rooms.createRoom(meta.playerId, payload.displayName, ws);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      broadcastRoom(result.room, shareBaseFrom(req, payload));
      return;
    }

    case ClientMsg.JOIN_ROOM: {
      const result = rooms.joinRoom(payload.roomId, meta.playerId, payload.displayName, ws);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      broadcastRoom(result.room, shareBaseFrom(req, payload));
      return;
    }

    case ClientMsg.RECONNECT: {
      const requestedId = String(payload.playerId || '');
      if (!requestedId) {
        send(ws, ServerMsg.ERROR, { code: ErrorCode.BAD_REQUEST, message: '缺少 playerId' });
        return;
      }
      // Bind this socket to the previous player id for session restore
      meta.playerId = requestedId;
      send(ws, ServerMsg.WELCOME, { playerId: requestedId });

      const result = rooms.reconnectPlayer(requestedId, ws);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      broadcastRoom(result.room, shareBaseFrom(req, payload));
      return;
    }

    case ClientMsg.PLACE: {
      const result = rooms.place(meta.playerId, payload.x, payload.y);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      broadcastRoom(result.room);
      return;
    }

    case ClientMsg.REMATCH_READY: {
      const result = rooms.rematchReady(meta.playerId);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      broadcastRoom(result.room);
      return;
    }

    case ClientMsg.REMATCH_CANCEL: {
      const result = rooms.rematchCancel(meta.playerId);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      broadcastRoom(result.room);
      return;
    }

    case ClientMsg.LEAVE: {
      const result = rooms.leave(meta.playerId);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      if (result.dissolved) {
        notifyDissolved(result.others || []);
      } else if (result.room) {
        broadcastRoom(result.room);
      }
      return;
    }

    case ClientMsg.LEAVE_REQUEST: {
      const result = rooms.requestLeave(meta.playerId);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      if (result.leftImmediately) {
        send(ws, ServerMsg.ROOM_UPDATE, {
          roomId: null,
          status: 'dissolved',
          players: [],
          rematchReady: {},
          leaveRequestFrom: null,
          shareUrl: null,
          youAre: { playerId: meta.playerId, color: null, isHost: false, rematchReady: false },
          game: null,
        });
      }
      if (result.dissolved) {
        notifyDissolved(result.others || []);
      } else if (result.room) {
        broadcastRoom(result.room);
      }
      return;
    }

    case ClientMsg.LEAVE_ACCEPT: {
      const result = rooms.acceptLeave(meta.playerId);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      if (result.dissolved) {
        notifyDissolved(result.others || []);
      }
      return;
    }

    case ClientMsg.LEAVE_REJECT: {
      const result = rooms.rejectLeave(meta.playerId);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      broadcastRoom(result.room);
      return;
    }

    case ClientMsg.LEAVE_CANCEL: {
      const result = rooms.cancelLeave(meta.playerId);
      if (!result.ok) {
        send(ws, ServerMsg.ERROR, { code: result.code, message: result.message });
        return;
      }
      broadcastRoom(result.room);
      return;
    }

    default:
      send(ws, ServerMsg.ERROR, { code: ErrorCode.BAD_REQUEST, message: '未知消息类型' });
  }
}

function notifyDissolved(others) {
  for (const p of others) {
    if (p.ws && p.ws.readyState === 1) {
      send(p.ws, ServerMsg.ROOM_UPDATE, {
        roomId: null,
        status: 'dissolved',
        players: [],
        rematchReady: {},
        leaveRequestFrom: null,
        shareUrl: null,
        youAre: { playerId: p.id, color: null, isHost: false, rematchReady: false },
        game: null,
      });
    }
  }
}

function broadcastRoom(room, shareBase) {
  if (shareBase) room.lanShareBase = shareBase;
  const base = room.lanShareBase || `http://localhost:${PORT}`;

  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const snap = rooms.buildSnapshot(room, p.id, base);
    send(p.ws, ServerMsg.ROOM_UPDATE, snap);
  }
}

function shareBaseFrom(req, payload) {
  if (payload && payload.shareBase && typeof payload.shareBase === 'string') {
    return payload.shareBase.replace(/\/$/, '');
  }
  const host = req.headers.host;
  if (host) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
}

function send(ws, type, payload) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type, payload }));
}

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const result = [];
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === 'IPv4' && !net.internal) {
        result.push(net.address);
      }
    }
  }
  return result;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('五子棋服务已启动');
  console.log(`  本机:   http://localhost:${PORT}`);
  const lans = getLanAddresses();
  if (lans.length === 0) {
    console.log('  局域网: （未检测到 IPv4 地址）');
  } else {
    for (const ip of lans) {
      console.log(`  局域网: http://${ip}:${PORT}`);
    }
  }
  console.log('');
});
