import { randomBytes } from 'node:crypto';
import { generateRoomCode, normalizeRoomCode } from '../utils/roomCode.js';

const sessionToken = () => randomBytes(32).toString('base64url');

export class RoomManager {
  constructor({
    waitingRoomTtlMs = 10 * 60 * 1000,
    activeRoomIdleTtlMs = 60 * 60 * 1000,
    disconnectGraceMs = 45 * 1000,
    maxRooms = 1000,
    now = Date.now,
    schedule = setTimeout,
    cancel = clearTimeout,
    onRoomExpired = () => {},
    onParticipantLeft = () => {},
    onParticipantRemoved = () => {},
    onRoomDestroyed = () => {},
  } = {}) {
    this.waitingRoomTtlMs = waitingRoomTtlMs;
    this.activeRoomIdleTtlMs = activeRoomIdleTtlMs;
    this.disconnectGraceMs = disconnectGraceMs;
    this.maxRooms = maxRooms;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onRoomExpired = onRoomExpired;
    this.onParticipantLeft = onParticipantLeft;
    this.onParticipantRemoved = onParticipantRemoved;
    this.onRoomDestroyed = onRoomDestroyed;
    this.rooms = new Map();
  }

  createRoom(socketId) {
    if (this.rooms.size >= this.maxRooms) return { ok: false, code: 'ROOM_LIMIT' };
    let roomCode;
    do {
      roomCode = generateRoomCode();
    } while (this.rooms.has(roomCode));

    const timestamp = this.now();
    const room = {
      roomCode,
      state: 'WAITING',
      createdAt: timestamp,
      lastActivityAt: timestamp,
      expiresAt: timestamp + this.waitingRoomTtlMs,
      participants: new Map(),
      expiryTimer: null,
    };
    const sessionId = sessionToken();
    room.participants.set(sessionId, {
      sessionId,
      socketId,
      connected: true,
      disconnectedAt: null,
      graceTimer: null,
      joinedAt: timestamp,
    });
    this.rooms.set(roomCode, room);
    this.#scheduleExpiry(room);
    return this.#joinResult(room, sessionId, false, true);
  }

  joinRoom({ roomCode: rawCode, sessionId, socketId }) {
    const roomCode = normalizeRoomCode(rawCode);
    if (!roomCode) return { ok: false, code: 'INVALID_ROOM_CODE' };
    const room = this.rooms.get(roomCode);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };

    if (room.expiresAt <= this.now()) {
      this.#expire(room);
      return { ok: false, code: 'ROOM_EXPIRED' };
    }

    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const participant = room.participants.get(sessionId);
      if (!participant) return { ok: false, code: 'INVALID_SESSION' };
      if (participant.connected && participant.socketId !== socketId) {
        return { ok: false, code: 'SESSION_IN_USE' };
      }
      const wasDisconnected = !participant.connected;
      if (participant.graceTimer) this.cancel(participant.graceTimer);
      participant.graceTimer = null;
      participant.connected = true;
      participant.disconnectedAt = null;
      participant.socketId = socketId;
      this.#touch(room);
      return this.#joinResult(room, sessionId, wasDisconnected, false);
    }

    if (room.participants.size >= 2) return { ok: false, code: 'ROOM_FULL' };
    const previousCount = room.participants.size;
    const newSessionId = sessionToken();
    const timestamp = this.now();
    room.participants.set(newSessionId, {
      sessionId: newSessionId,
      socketId,
      connected: true,
      disconnectedAt: null,
      graceTimer: null,
      joinedAt: timestamp,
    });
    if (room.participants.size === 2) {
      room.state = 'ACTIVE';
      room.lastActivityAt = timestamp;
    }
    this.#touch(room);
    return {
      ...this.#joinResult(room, newSessionId, false, false),
      participantJoined: previousCount > 0,
    };
  }

  disconnect(roomCode, sessionId, socketId) {
    const room = this.rooms.get(roomCode);
    const participant = room?.participants.get(sessionId);
    if (!participant || participant.socketId !== socketId || !participant.connected) return null;

    participant.connected = false;
    participant.disconnectedAt = this.now();
    participant.graceTimer = this.schedule(() => {
      const currentRoom = this.rooms.get(roomCode);
      const current = currentRoom?.participants.get(sessionId);
      if (!current || current.connected) return;
      this.#removeParticipant(currentRoom, current);
    }, this.disconnectGraceMs);
    participant.graceTimer?.unref?.();
    return { roomCode, state: room.state, participantCount: room.participants.size };
  }

  endRoom(roomCode, sessionId) {
    const room = this.rooms.get(roomCode);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
    if (!room.participants.has(sessionId)) return { ok: false, code: 'NOT_IN_ROOM' };
    const socketIds = this.#connectedSocketIds(room);
    this.#destroy(room);
    return { ok: true, socketIds };
  }

  leaveRoom(roomCode, sessionId, socketId) {
    const room = this.rooms.get(normalizeRoomCode(roomCode));
    const participant = room?.participants.get(sessionId);
    if (!participant?.connected || participant.socketId !== socketId)
      return { ok: false, code: 'NOT_IN_ROOM' };
    this.#removeParticipant(room, participant);
    return { ok: true, participantCount: room.participants.size };
  }

  touch(roomCode, sessionId, socketId) {
    const room = this.rooms.get(normalizeRoomCode(roomCode));
    if (!this.isCurrentParticipant(roomCode, sessionId, socketId)) return false;
    this.#touch(room);
    return true;
  }

  isCurrentParticipant(roomCode, sessionId, socketId) {
    const room = this.rooms.get(roomCode);
    const participant = room?.participants.get(sessionId);
    return Boolean(
      room &&
        room.expiresAt > this.now() &&
        participant?.connected &&
        participant.socketId === socketId,
    );
  }

  getRoom(roomCode) {
    return this.rooms.get(normalizeRoomCode(roomCode)) ?? null;
  }

  #joinResult(room, sessionId, reconnected, created) {
    return {
      ok: true,
      roomCode: room.roomCode,
      sessionId,
      state: room.state,
      participantCount: room.participants.size,
      expiresAt: room.expiresAt,
      reconnected,
      created,
    };
  }

  #connectedSocketIds(room) {
    return [...room.participants.values()]
      .filter((participant) => participant.connected)
      .map((participant) => participant.socketId);
  }

  #touch(room) {
    room.lastActivityAt = this.now();
    if (room.state === 'ACTIVE') {
      room.expiresAt = room.lastActivityAt + this.activeRoomIdleTtlMs;
      this.#scheduleExpiry(room);
    }
  }

  #scheduleExpiry(room) {
    if (room.expiryTimer) this.cancel(room.expiryTimer);
    const delay = Math.max(0, room.expiresAt - this.now());
    room.expiryTimer = this.schedule(() => {
      if (this.rooms.get(room.roomCode) !== room) return;
      if (room.expiresAt > this.now()) {
        this.#scheduleExpiry(room);
      } else {
        this.#expire(room);
      }
    }, delay);
    room.expiryTimer?.unref?.();
  }

  #expire(room) {
    const socketIds = this.#connectedSocketIds(room);
    this.onRoomExpired({ roomCode: room.roomCode, socketIds });
    this.#destroy(room);
  }

  #removeParticipant(room, participant) {
    if (participant.graceTimer) this.cancel(participant.graceTimer);
    room.participants.delete(participant.sessionId);
    this.onParticipantRemoved({ roomCode: room.roomCode, sessionId: participant.sessionId });
    this.onParticipantLeft({
      roomCode: room.roomCode,
      remainingSocketIds: this.#connectedSocketIds(room),
      participantCount: room.participants.size,
    });
    if (room.participants.size === 0) {
      this.#destroy(room);
      return;
    }
    room.state = 'WAITING';
    room.expiresAt = this.now() + this.waitingRoomTtlMs;
    this.#scheduleExpiry(room);
  }

  #destroy(room) {
    if (room.expiryTimer) this.cancel(room.expiryTimer);
    for (const participant of room.participants.values()) {
      if (participant.graceTimer) this.cancel(participant.graceTimer);
      this.onParticipantRemoved({ roomCode: room.roomCode, sessionId: participant.sessionId });
    }
    room.state = 'ENDED';
    room.participants.clear();
    this.rooms.delete(room.roomCode);
    this.onRoomDestroyed({ roomCode: room.roomCode });
  }
}
