'use strict';

/** @typedef {'waiting' | 'playing' | 'finished' | 'paused'} RoomStatus */

const ClientMsg = {
  CREATE_ROOM: 'create_room',
  JOIN_ROOM: 'join_room',
  RECONNECT: 'reconnect',
  PLACE: 'place',
  REMATCH_READY: 'rematch_ready',
  REMATCH_CANCEL: 'rematch_cancel',
  LEAVE: 'leave',
  LEAVE_REQUEST: 'leave_request',
  LEAVE_ACCEPT: 'leave_accept',
  LEAVE_REJECT: 'leave_reject',
  LEAVE_CANCEL: 'leave_cancel',
  PING: 'ping',
};

const ServerMsg = {
  WELCOME: 'welcome',
  ROOM_UPDATE: 'room_update',
  ERROR: 'error',
  PONG: 'pong',
};

const ErrorCode = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_MOVE: 'INVALID_MOVE',
  NOT_READY: 'NOT_READY',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  LEAVE_NEEDS_CONSENT: 'LEAVE_NEEDS_CONSENT',
  BAD_REQUEST: 'BAD_REQUEST',
};

module.exports = { ClientMsg, ServerMsg, ErrorCode };
