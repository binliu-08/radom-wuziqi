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
    turnTimer: document.getElementById('turn-timer'),
    turnTimerText: document.getElementById('turn-timer-text'),
    turnTimerRing: document.getElementById('turn-timer-ring'),
    turnTimerCaption: document.getElementById('turn-timer-caption'),
    scoreboard: document.getElementById('scoreboard'),
    scoreboardPlayers: document.getElementById('scoreboard-players'),
    scoreboardDraws: document.getElementById('scoreboard-draws'),
    shareBox: document.getElementById('share-box'),
    shareUrl: document.getElementById('share-url'),
    btnCopy: document.getElementById('btn-copy'),
    boardWrap: document.getElementById('board-wrap'),
    board: document.getElementById('board'),
    resultModal: document.getElementById('result-modal'),
    resultTitle: document.getElementById('result-title'),
    resultHint: document.getElementById('result-hint'),
    btnRematch: document.getElementById('btn-rematch'),
    btnRematchCancel: document.getElementById('btn-rematch-cancel'),
    btnResultExit: document.getElementById('btn-result-exit'),
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
    timerInterval: null,
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
    const url = (els.shareUrl.value || '').trim() ||
      (state.room ? `${location.origin}/?room=${state.room.roomId}` : '');
    if (!url) {
      showToast('暂无链接可复制');
      return;
    }
    els.shareUrl.value = url;
    const ok = await copyText(url);
    showToast(ok ? '链接已复制' : '复制失败，请长按链接手动复制');
    if (!ok) {
      els.shareUrl.focus();
      els.shareUrl.select();
    }
  });

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // fall through
      }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

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
  els.btnResultExit.addEventListener('click', () => {
    send('leave', {});
    resetToLobby('已离开房间');
  });

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
    stopTurnCountdown();
    els.lobby.hidden = false;
    els.room.hidden = true;
    els.resultModal.hidden = true;
    els.turnTimer.hidden = true;
    if (els.scoreboard) els.scoreboard.hidden = true;
    // Clear room query without reload
    if (location.search) {
      history.replaceState({}, '', location.pathname);
    }
    if (message) showToast(message);
  }

  function isMyTurn(room) {
    const g = room?.game;
    if (!g || room.status !== 'playing') return false;
    const myId = room.youAre.playerId;
    return (
      (g.current === 1 && g.blackPlayerId === myId) || (g.current === 2 && g.whitePlayerId === myId)
    );
  }

  function stopTurnCountdown() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function updateTurnTimerDisplay() {
    const room = state.room;
    const game = room?.game;
    // 只要本局棋盘还在，左侧栏就保持占位，避免换手时页面跳动
    if (!room || !game || room.status === 'waiting') {
      els.turnTimer.hidden = true;
      return;
    }

    els.turnTimer.hidden = false;
    const myTurn = isMyTurn(room);
    const total = game.turnSeconds || 20;
    const circumference = 2 * Math.PI * 30;

    if (room.status === 'finished') {
      els.turnTimerText.textContent = '—';
      els.turnTimerCaption.textContent = '本局结束';
      els.turnTimer.classList.remove('urgent', 'waiting-opponent');
      if (els.turnTimerRing) {
        els.turnTimerRing.style.strokeDasharray = String(circumference);
        els.turnTimerRing.style.strokeDashoffset = String(circumference);
      }
      return;
    }

    if (room.status === 'paused' || !game.turnDeadline) {
      const remainSec =
        game.turnRemainingMs != null
          ? Math.ceil(game.turnRemainingMs / 1000)
          : '—';
      els.turnTimerText.textContent = String(remainSec);
      els.turnTimerCaption.textContent = '已暂停';
      els.turnTimer.classList.remove('urgent');
      els.turnTimer.classList.add('waiting-opponent');
      return;
    }

    const remainMs = Math.max(0, game.turnDeadline - Date.now());
    const remain = Math.ceil(remainMs / 1000);
    const progress = Math.min(1, Math.max(0, remainMs / (total * 1000)));

    els.turnTimerText.textContent = String(remain);
    els.turnTimerCaption.textContent = myTurn ? '思考中' : '对方思考';
    els.turnTimer.classList.toggle('urgent', myTurn && remain <= 5);
    els.turnTimer.classList.toggle('waiting-opponent', !myTurn);
    if (els.turnTimerRing) {
      els.turnTimerRing.style.strokeDasharray = String(circumference);
      els.turnTimerRing.style.strokeDashoffset = String(circumference * (1 - progress));
    }
  }

  function syncTurnCountdown() {
    stopTurnCountdown();
    updateTurnTimerDisplay();
    // 对局中持续刷新，换手也不卸掉侧栏
    if (state.room?.game && state.room.status !== 'waiting') {
      state.timerInterval = setInterval(updateTurnTimerDisplay, 200);
    }
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

    renderResultModal(room);
    renderLeaveActions(room);
    renderScoreboard(room);
    syncTurnCountdown();

    els.statusText.textContent = statusLabel(room);
  }

  function renderScoreboard(room) {
    if (!els.scoreboard) return;
    const board = room.scoreboard;
    if (!board || !room.players.length) {
      els.scoreboard.hidden = true;
      return;
    }
    els.scoreboard.hidden = false;
    const myId = room.youAre.playerId;
    const players = board.players && board.players.length
      ? board.players
      : room.players.map((p) => ({ id: p.id, name: p.name, wins: 0 }));

    els.scoreboardPlayers.innerHTML = players
      .map((p) => {
        const me = p.id === myId ? ' me' : '';
        const name = escapeHtml(p.name || '玩家');
        return `<li class="scoreboard-player${me}">
          <span class="scoreboard-name">${name}${p.id === myId ? '（你）' : ''}</span>
          <span class="scoreboard-wins">${Number(p.wins) || 0}</span>
          <span class="scoreboard-wins-label">胜</span>
        </li>`;
      })
      .join('');
    els.scoreboardDraws.textContent = String(board.draws || 0);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function resultText(room) {
    const g = room.game;
    const myId = room.youAre.playerId;
    if (!g || g.winner === null) return { title: '对局结束', kind: '' };
    if (g.winner === 0) return { title: '和棋', kind: 'draw' };
    if (g.winner === 1) {
      return g.blackPlayerId === myId
        ? { title: '你赢了', kind: 'win' }
        : { title: '你输了', kind: 'lose' };
    }
    return g.whitePlayerId === myId
      ? { title: '你赢了', kind: 'win' }
      : { title: '你输了', kind: 'lose' };
  }

  function rematchHint(room) {
    const g = room.game;
    let base = '双方都确认后开始新局';
    if (g?.winReason === 'timeout') {
      base = '超时判负 · 双方都确认后开始新局';
    }
    const myId = room.youAre.playerId;
    const readyMap = room.rematchReady || {};
    const opponent = room.players.find((p) => p.id !== myId);
    const oppReady = opponent ? !!readyMap[opponent.id] : false;
    const meReady = !!readyMap[myId];
    if (meReady && !oppReady) return g?.winReason === 'timeout' ? '超时判负 · 已确认，等待对方确认' : '已确认，等待对方确认';
    if (!meReady && oppReady) return g?.winReason === 'timeout' ? '超时判负 · 对方已确认再来一局' : '对方已确认再来一局';
    if (meReady && oppReady) return '双方已确认，即将开局';
    return base;
  }

  function renderResultModal(room) {
    const show = room.status === 'finished' && !!room.game;
    els.resultModal.hidden = !show;
    if (!show) return;

    const { title, kind } = resultText(room);
    els.resultTitle.textContent = title;
    els.resultTitle.className = `result-title${kind ? ` ${kind}` : ''}`;
    els.resultHint.textContent = rematchHint(room);

    const ready = !!room.youAre?.rematchReady;
    els.btnRematch.hidden = ready;
    els.btnRematchCancel.hidden = !ready;
  }

  function needsLeaveConsent(room) {
    if (!room || room.players.length < 2) return false;
    if (room.status !== 'playing' && room.status !== 'paused') return false;
    return room.players.every((p) => p.connected);
  }

  function renderLeaveActions(room) {
    const from = room.leaveRequestFrom;
    const myId = room.youAre.playerId;
    const finished = room.status === 'finished';

    if (finished && !from) {
      els.leaveActions.hidden = true;
      els.btnLeave.hidden = true;
      return;
    }

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
      return '本局已结束';
    }

    // playing
    const g = room.game;
    const myTurn = isMyTurn(room);
    if (myTurn) return '轮到你落子（限时 20 秒）';
    return '等待对方落子';
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
      const last = game.lastMove;
      if (last) {
        drawLastMoveMark(pad + last.x * cell, pad + last.y * cell, cell, game.board[last.y][last.x] === 1);
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

  function drawLastMoveMark(cx, cy, cell, isBlack) {
    const r = Math.max(3, cell * 0.12);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = isBlack ? '#e8c15a' : '#c0392b';
    ctx.fill();
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
