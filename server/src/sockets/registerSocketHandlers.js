const errorText = {
  INVALID_ROOM_CODE: 'Enter a valid 6-character room code.',
  ROOM_NOT_FOUND: 'This room no longer exists.',
  ROOM_EXPIRED: 'This room has expired.',
  ROOM_FULL: 'This room is already full. Only two people can participate.',
  INVALID_SESSION: 'This session can no longer be restored. Rejoin with the invite link.',
  SESSION_IN_USE: 'This session is already connected in another tab.',
  ROOM_LIMIT: 'The server has reached its temporary room limit. Try again later.',
  NOT_IN_ROOM: 'You are no longer a participant in this room.',
  RATE_LIMITED: 'You are sending messages too quickly. Please wait a moment.',
  MESSAGE_TOO_LONG: 'That message is too long.',
  INVALID_MESSAGE: 'The encrypted message could not be accepted.',
};

const reply = (ack, value) => {
  if (typeof ack === 'function') ack(value);
};
const failure = (code, extra = {}) => ({
  ok: false,
  error: { code, message: errorText[code] ?? 'The request could not be completed.', ...extra },
});
const validCiphertext = (payload, maxPlaintextLength) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (
    payload.version !== 1 ||
    typeof payload.iv !== 'string' ||
    typeof payload.ciphertext !== 'string'
  )
    return false;
  if (!/^[A-Za-z0-9_-]{16}$/.test(payload.iv) || !/^[A-Za-z0-9_-]+$/.test(payload.ciphertext))
    return false;
  const decodedLength = Math.floor((payload.ciphertext.length * 3) / 4);
  return decodedLength >= 16 && decodedLength <= maxPlaintextLength * 4 + 16;
};

export function registerSocketHandlers(
  io,
  { roomManager, rateLimiter, roomActionRateLimiter, config },
) {
  const typingTimers = new Map();
  const lastTypingAt = new Map();

  const clearTyping = (sessionId, roomCode) => {
    const timer = typingTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    typingTimers.delete(sessionId);
    lastTypingAt.delete(sessionId);
    if (roomCode) io.to(roomCode).emit('typing:update', { typing: false });
  };

  roomManager.onRoomExpired = ({ roomCode }) => {
    io.to(roomCode).emit('room:expired', { message: 'This room no longer exists.' });
    io.in(roomCode).socketsLeave(roomCode);
  };
  roomManager.onParticipantLeft = ({ roomCode }) => {
    io.to(roomCode).emit('participant:left', { message: 'Someone left the room.' });
  };
  roomManager.onParticipantRemoved = ({ sessionId }) => {
    rateLimiter.delete(sessionId);
    clearTyping(sessionId);
  };

  const releaseCurrentSeat = (socket) => {
    const { roomCode, sessionId } = socket.data;
    if (!roomCode || !sessionId) return;
    socket.leave(roomCode);
    roomManager.leaveRoom(roomCode, sessionId, socket.id);
    socket.data.roomCode = null;
    socket.data.sessionId = null;
  };

  const allowRoomAction = (socket, ack) => {
    const rate = roomActionRateLimiter.consume(socket.id);
    if (rate.allowed) return true;
    reply(ack, failure('RATE_LIMITED', { retryAfterMs: rate.retryAfterMs }));
    return false;
  };

  io.on('connection', (socket) => {
    socket.on('room:create', (_payload, ack) => {
      if (!allowRoomAction(socket, ack)) return;
      const result = roomManager.createRoom(socket.id);
      if (!result.ok) {
        reply(ack, failure(result.code));
        return;
      }
      releaseCurrentSeat(socket);
      socket.data.roomCode = result.roomCode;
      socket.data.sessionId = result.sessionId;
      socket.join(result.roomCode);
      reply(ack, { ok: true, data: result });
    });

    socket.on('room:join', (payload, ack) => {
      if (!allowRoomAction(socket, ack)) return;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        reply(ack, failure('INVALID_ROOM_CODE'));
        return;
      }
      const result = roomManager.joinRoom({
        roomCode: payload.roomCode,
        sessionId: payload.sessionId,
        socketId: socket.id,
      });
      if (!result.ok) {
        reply(ack, failure(result.code));
        return;
      }
      const previousRoom = socket.data.roomCode;
      if (previousRoom && previousRoom !== result.roomCode) releaseCurrentSeat(socket);
      socket.data.roomCode = result.roomCode;
      socket.data.sessionId = result.sessionId;
      socket.join(result.roomCode);
      if (result.participantJoined)
        socket
          .to(result.roomCode)
          .emit('participant:joined', { message: 'Someone joined the room.' });
      if (result.reconnected)
        socket
          .to(result.roomCode)
          .emit('participant:connection', { connected: true, message: 'Connection restored.' });
      reply(ack, { ok: true, data: result });
    });

    socket.on('room:leave', (_payload, ack) => {
      releaseCurrentSeat(socket);
      reply(ack, { ok: true });
    });

    socket.on('message:send', (payload, ack) => {
      const { roomCode, sessionId } = socket.data;
      if (!roomManager.isCurrentParticipant(roomCode, sessionId, socket.id)) {
        reply(ack, failure('NOT_IN_ROOM'));
        return;
      }
      if (!validCiphertext(payload, config.maxMessageLength)) {
        const code =
          payload?.ciphertext?.length > Math.ceil(((config.maxMessageLength * 4 + 16) * 4) / 3)
            ? 'MESSAGE_TOO_LONG'
            : 'INVALID_MESSAGE';
        reply(ack, failure(code));
        return;
      }
      const rate = rateLimiter.consume(sessionId);
      if (!rate.allowed) {
        reply(ack, failure('RATE_LIMITED', { retryAfterMs: rate.retryAfterMs }));
        return;
      }
      const encryptedPacket = {
        version: 1,
        iv: payload.iv,
        ciphertext: payload.ciphertext,
        sentAt: Date.now(),
      };
      socket.to(roomCode).emit('message:receive', { ...encryptedPacket, mine: false });
      socket.emit('message:receive', { ...encryptedPacket, mine: true });
      roomManager.touch(roomCode, sessionId, socket.id);
      reply(ack, { ok: true });
    });

    socket.on('typing:start', () => {
      const { roomCode, sessionId } = socket.data;
      if (!roomManager.isCurrentParticipant(roomCode, sessionId, socket.id)) return;
      const now = Date.now();
      if (now - (lastTypingAt.get(sessionId) ?? 0) < 250) return;
      lastTypingAt.set(sessionId, now);
      socket.to(roomCode).emit('typing:update', { typing: true });
      const oldTimer = typingTimers.get(sessionId);
      if (oldTimer) clearTimeout(oldTimer);
      const timer = setTimeout(() => clearTyping(sessionId, roomCode), 5000);
      timer.unref?.();
      typingTimers.set(sessionId, timer);
    });

    socket.on('typing:stop', () => {
      const { roomCode, sessionId } = socket.data;
      if (!roomManager.isCurrentParticipant(roomCode, sessionId, socket.id)) return;
      clearTyping(sessionId, roomCode);
    });

    socket.on('room:end', (_payload, ack) => {
      const { roomCode, sessionId } = socket.data;
      const result = roomManager.endRoom(roomCode, sessionId);
      if (!result.ok) {
        reply(ack, failure(result.code));
        return;
      }
      io.to(roomCode).emit('room:ended', {
        message: 'This chat has ended. Nothing from this room was saved by the application.',
      });
      io.in(roomCode).socketsLeave(roomCode);
      for (const id of result.socketIds) {
        const participantSocket = io.sockets.sockets.get(id);
        if (participantSocket) {
          participantSocket.data.roomCode = null;
          participantSocket.data.sessionId = null;
        }
      }
      reply(ack, { ok: true });
    });

    socket.on('disconnect', () => {
      roomActionRateLimiter.delete(socket.id);
      const { roomCode, sessionId } = socket.data;
      if (!roomCode || !sessionId) return;
      clearTyping(sessionId, roomCode);
      const result = roomManager.disconnect(roomCode, sessionId, socket.id);
      if (result)
        io.to(roomCode).emit('participant:connection', {
          connected: false,
          message: 'Someone lost connection. Their seat is reserved briefly.',
        });
    });
  });
}
