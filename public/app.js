(() => {
  const BOARD_SIZE = 15;
  const STORAGE_KEY = 'wuziqi.playerId';
  const NAME_KEY = 'wuziqi.displayName';

  const els = {
    lobby: document.getElementById('view-lobby'),
    room: document.getElementById('view-room'),
    displayName: document.getElementById('display-name'),
    roomInput: document.getElementById('room-input'),
    btnCreate: document.getElementById('btn-create'),
    btnJoin: document.getElementById('btn-join'),
    roomId: document.getElementById('room-id'),
    colorBadge: document.getElementById('color-badge'),
    statusText: document.getElementById('status-text'),
    shareBox: document.getElementById('share-box'),
    shareUrl: document.getElementById('share-url'),
    btnCopy: document.getElementById('btn-copy'),
    boardWrap: document.getElementById('board-wrap'),
    board: document.getElementById('board'),
    finishedActions: document.getElementById('finished-actions'),
    btnRematch: document.getElementById('btn-rematch'),
    btnRematchCancel: document.getElementById('btn-rematch-cancel'),
    leaveActions: document.getElementById('leave-actions'),
    btnLeaveAccept: document.getElementById('btn-leave-accept'),
    btnLeaveReject: document.getElementById('btn-leave-reject'),
    btnLeaveCancel: document.getElementById('btn-leave-cancel'),
    btnLeave: document.getElementById('btn-leave'),
    toast: document.getElementById('toast'),
  };

  const ctx = els.board.getContext('2d');
  const state = {
    ws: null,
    playerId: localStorage.getItem(STORAGE_KEY) || null,
    room: null,
    hover: null,
    reconnectAttempted: false,
  };

  els.displayName.value = localStorage.getItem(NAME_KEY) || '';

  const params = new URLSearchParams(location.search);
  const pendingRoom = (params.get('room') || '').trim().toUpperCase();
  if (pendingRoom) els.roomInput.value = pendingRoom;

  connect();

  els.btnCreate.addEventListener('click', () => {
    persistName();
    send('create_room', {
      displayName: els.displayName.value,
      shareBase: location.origin,
    });
  });

  els.btnJoin.addEventListener('click', () => joinRoom(els.roomInput.value));
  els.roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom(els.roomInput.value);
  });

  els.btnCopy.addEventListener('click', async () => {
    const url = els.shareUrl.value;
    try {
      await navigator.clipboard.writeText(url);
      showToast('链接已复制');
    } catch {
      els.shareUrl.select();
      showToast('请手动复制链接');
    }
  });

  els.btnLeave.addEventListener('click', () => {
    const room = state.room;
    if (room && needsLeaveConsent(room)) {
      send('leave_request', {});
      showToast('已向对方申请离开，等待同意');
      return;
    }
    send('leave', {});
    resetToLobby('已离开房间');
  });

  els.btnLeaveAccept.addEventListener('click', () => send('leave_accept', {}));
  els.btnLeaveReject.addEventListener('click', () => send('leave_reject', {}));
  els.btnLeaveCancel.addEventListener('click', () => send('leave_cancel', {}));

  els.btnRematch.addEventListener('click', () => send('rematch_ready', {}));
  els.btnRematchCancel.addEventListener('click', () => send('rematch_cancel', {}));

  els.board.addEventListener('pointermove', (e) => {
    const cell = pointerToCell(e);
    state.hover = cell;
    drawBoard();
  });
  els.board.addEventListener('pointerleave', () => {
    state.hover = null;
    drawBoard();
  });
  els.board.addEventListener('pointerdown', (e) => {
    const cell = pointerToCell(e);
    if (!cell || !state.room || state.room.status !== 'playing') return;
    send('place', { x: cell.x, y: cell.y });
  });

  window.addEventListener('resize', () => {
    if (state.room?.game) drawBoard();
  });

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    state.ws = ws;
    state.reconnectAttempted = false;

    ws.addEventListener('open', () => {
      startHeartbeat();
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      onMessage(msg);
    });

    ws.addEventListener('close', () => {
      stopHeartbeat();
      showToast('连接断开，正在重连…');
      setTimeout(connect, 1200);
    });
  }

  let heartbeatTimer = null;
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => send('ping', {}), 25000);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function onMessage(msg) {
    const { type, payload } = msg;
    if (type === 'welcome') {
      const assigned = payload.playerId;
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && stored !== assigned && !state.reconnectAttempted) {
        state.reconnectAttempted = true;
        send('reconnect', {
          playerId: stored,
          shareBase: location.origin,
        });
        return;
      }
      // Fresh session or reconnect already handled
      state.playerId = assigned;
      localStorage.setItem(STORAGE_KEY, assigned);
      if (!state.reconnectAttempted && pendingRoom && !state.room) {
        joinRoom(pendingRoom);
      }
      state.reconnectAttempted = false;
      return;
    }

    if (type === 'room_update') {
      if (payload.status === 'dissolved' || !payload.roomId) {
        resetToLobby('房间已解散');
        return;
      }
      state.room = payload;
      if (payload.youAre?.playerId) {
        state.playerId = payload.youAre.playerId;
        localStorage.setItem(STORAGE_KEY, state.playerId);
      }
      renderRoom();
      return;
    }

    if (type === 'error') {
      showToast(payload.message || '出错了');
      return;
    }
  }

  function joinRoom(roomId) {
    persistName();
    const id = String(roomId || '').trim().toUpperCase();
    if (!id) {
      showToast('请输入房间号');
      return;
    }
    send('join_room', {
      roomId: id,
      displayName: els.displayName.value,
      shareBase: location.origin,
    });
  }

  function send(type, payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      showToast('尚未连接服务器');
      return;
    }
    state.ws.send(JSON.stringify({ type, payload }));
  }

  function persistName() {
    localStorage.setItem(NAME_KEY, els.displayName.value.trim());
  }

  function resetToLobby(message) {
    state.room = null;
    els.lobby.hidden = false;
    els.room.hidden = true;
    // Clear room query without reload
    if (location.search) {
      history.replaceState({}, '', location.pathname);
    }
    if (message) showToast(message);
  }

  function renderRoom() {
    const room = state.room;
    if (!room) return;

    els.lobby.hidden = true;
    els.room.hidden = false;
    els.roomId.textContent = room.roomId;

    const color = room.youAre?.color;
    if (color) {
      els.colorBadge.hidden = false;
      els.colorBadge.className = `color-badge ${color}`;
      els.colorBadge.textContent = color === 'black' ? '你执黑 · 先手' : '你执白 · 后手';
    } else {
      els.colorBadge.hidden = true;
    }

    els.shareUrl.value = room.shareUrl || `${location.origin}/?room=${room.roomId}`;
    const showShare = room.status === 'waiting' || room.players.length < 2;
    els.shareBox.hidden = !showShare;

    const hasBoard = !!room.game;
    els.boardWrap.hidden = !hasBoard;
    if (hasBoard) drawBoard();

    els.finishedActions.hidden = room.status !== 'finished';
    if (room.status === 'finished') {
      const ready = !!room.youAre?.rematchReady;
      els.btnRematch.hidden = ready;
      els.btnRematchCancel.hidden = !ready;
      els.btnRematch.disabled = false;
    }

    renderLeaveActions(room);

    els.statusText.textContent = statusLabel(room);
  }

  function needsLeaveConsent(room) {
    if (!room || room.players.length < 2) return false;
    if (room.status !== 'playing' && room.status !== 'paused') return false;
    return room.players.every((p) => p.connected);
  }

  function renderLeaveActions(room) {
    const from = room.leaveRequestFrom;
    const myId = room.youAre.playerId;
    if (!from) {
      els.leaveActions.hidden = true;
      els.btnLeave.hidden = false;
      els.btnLeave.textContent = needsLeaveConsent(room) ? '申请离开' : '离开房间';
      return;
    }

    els.leaveActions.hidden = false;
    const iAmRequester = from === myId;
    els.btnLeaveAccept.hidden = iAmRequester;
    els.btnLeaveReject.hidden = iAmRequester;
    els.btnLeaveCancel.hidden = !iAmRequester;
    els.btnLeave.hidden = true;
  }

  function statusLabel(room) {
    if (room.leaveRequestFrom) {
      const myId = room.youAre.playerId;
      if (room.leaveRequestFrom === myId) {
        return '已申请离开，等待对方同意（整房将解散）';
      }
      return '对方申请离开对局，是否同意？（同意后房间解散）';
    }
    if (room.status === 'waiting') {
      return '等待对手加入…把链接发给局域网内的朋友即可';
    }
    if (room.status === 'paused') {
      return '对手已断开，对局暂停（约 60 秒内可重连；你可直接离开）';
    }
    if (room.status === 'finished') {
      const g = room.game;
      const myId = room.youAre.playerId;
      const readyMap = room.rematchReady || {};
      const opponent = room.players.find((p) => p.id !== myId);
      const oppReady = opponent ? !!readyMap[opponent.id] : false;
      const meReady = !!readyMap[myId];

      let result = '对局结束';
      if (g.winner === 0) result = '和棋';
      else if (g.winner === 1) {
        result = g.blackPlayerId === myId ? '你赢了' : '你输了';
      } else if (g.winner === 2) {
        result = g.whitePlayerId === myId ? '你赢了' : '你输了';
      }

      if (meReady && !oppReady) return `${result} · 已确认，等待对方确认再来一局`;
      if (!meReady && oppReady) return `${result} · 对方已确认再来一局`;
      if (meReady && oppReady) return `${result} · 双方已确认，即将开局`;
      return `${result} · 点击「再来一局」确认（需双方确认）`;
    }

    // playing
    const g = room.game;
    const myTurn =
      (g.current === 1 && g.blackPlayerId === room.youAre.playerId) ||
      (g.current === 2 && g.whitePlayerId === room.youAre.playerId);
    return myTurn ? '轮到你落子' : '等待对方落子';
  }

  function pointerToCell(e) {
    const rect = els.board.getBoundingClientRect();
    const scaleX = els.board.width / rect.width;
    const scaleY = els.board.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const pad = boardPadding();
    const cell = (els.board.width - pad * 2) / (BOARD_SIZE - 1);
    const x = Math.round((px - pad) / cell);
    const y = Math.round((py - pad) / cell);
    if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) return null;
    return { x, y };
  }

  function boardPadding() {
    return els.board.width * 0.06;
  }

  function drawBoard() {
    const size = els.board.width;
    const pad = boardPadding();
    const cell = (size - pad * 2) / (BOARD_SIZE - 1);
    const game = state.room?.game;

    ctx.clearRect(0, 0, size, size);

    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#e2b87a');
    grad.addColorStop(1, '#c99555');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(80, 50, 20, 0.55)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < BOARD_SIZE; i++) {
      const p = pad + i * cell;
      ctx.beginPath();
      ctx.moveTo(pad, p);
      ctx.lineTo(size - pad, p);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p, pad);
      ctx.lineTo(p, size - pad);
      ctx.stroke();
    }

    // star points
    const stars = [3, 7, 11];
    ctx.fillStyle = 'rgba(50, 30, 10, 0.75)';
    for (const sy of stars) {
      for (const sx of stars) {
        ctx.beginPath();
        ctx.arc(pad + sx * cell, pad + sy * cell, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (game) {
      for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
          const v = game.board[y][x];
          if (v) drawStone(pad + x * cell, pad + y * cell, cell, v === 1);
        }
      }
    }

    const canHover =
      state.room?.status === 'playing' &&
      state.hover &&
      game &&
      game.board[state.hover.y][state.hover.x] === 0;
    if (canHover) {
      const myColor = state.room.youAre.color;
      const isBlack = myColor === 'black';
      ctx.globalAlpha = 0.35;
      drawStone(pad + state.hover.x * cell, pad + state.hover.y * cell, cell, isBlack);
      ctx.globalAlpha = 1;
    }
  }

  function drawStone(cx, cy, cell, isBlack) {
    const r = cell * 0.42;
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.15, cx, cy, r);
    if (isBlack) {
      g.addColorStop(0, '#5a5a5a');
      g.addColorStop(1, '#111');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#d7d0c4');
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = isBlack ? 'rgba(0,0,0,0.5)' : 'rgba(80,60,40,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  let toastTimer = null;
  function showToast(text) {
    els.toast.hidden = false;
    els.toast.textContent = text;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2800);
  }
})();
