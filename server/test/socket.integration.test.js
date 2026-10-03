import test from 'node:test';
import assert from 'node:assert/strict';
import { io as createClient } from 'socket.io-client';
import { createApplication } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function waitFor(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once(event, handler);
  });
}
function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket
      .timeout(2000)
      .emit(event, payload, (error, response) => (error ? reject(error) : resolve(response)));
  });
}
async function connect(url) {
  const socket = createClient(url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Origin: 'http://localhost:5173' },
  });
  await waitFor(socket, 'connect');
  return socket;
}

async function withServer(
  run,
  { rateLimit = 10, roomActionLimit = 20, maxBuffer = 16 * 1024, maxRooms = 1000 } = {},
) {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    CLIENT_ORIGIN: 'http://localhost:5173',
    WAITING_ROOM_TTL_MS: '20000',
    ACTIVE_ROOM_IDLE_TTL_MS: '20000',
    DISCONNECT_GRACE_MS: '2000',
    MESSAGE_RATE_LIMIT: String(rateLimit),
    MESSAGE_RATE_WINDOW_MS: '5000',
    MAX_HTTP_BUFFER_SIZE: String(maxBuffer),
    ROOM_ACTION_RATE_LIMIT: String(roomActionLimit),
    ROOM_ACTION_RATE_WINDOW_MS: '60000',
    MAX_ROOMS: String(maxRooms),
    SERVE_CLIENT: 'false',
  });
  const application = createApplication({ config });
  await new Promise((resolve) => application.httpServer.listen(0, '127.0.0.1', resolve));
  const address = application.httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await run({ application, url });
  } finally {
    await application.close();
  }
}

test('live chat flow creates a room, admits a second participant, rejects a third, relays ciphertext, and ends for both', async () => {
  await withServer(async ({ application, url }) => {
    const first = await connect(url);
    const second = await connect(url);
    const third = await connect(url);
    const created = await emitAck(first, 'room:create');
    assert.equal(created.ok, true);
    const joined = await emitAck(second, 'room:join', { roomCode: created.data.roomCode });
    assert.equal(joined.ok, true);
    assert.equal(joined.data.state, 'ACTIVE');
    const full = await emitAck(third, 'room:join', { roomCode: created.data.roomCode });
    assert.equal(full.error.code, 'ROOM_FULL');

    const received = waitFor(second, 'message:receive');
    const encrypted = {
      version: 1,
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: Buffer.alloc(17).toString('base64url'),
    };
    assert.equal((await emitAck(first, 'message:send', encrypted)).ok, true);
    const relayed = await received;
    assert.equal(relayed.ciphertext, encrypted.ciphertext);
    assert.equal(relayed.iv, encrypted.iv);
    assert.equal(relayed.mine, false);
    assert.equal('plaintext' in relayed, false);

    const endedFirst = waitFor(first, 'room:ended');
    const endedSecond = waitFor(second, 'room:ended');
    assert.equal((await emitAck(first, 'room:end')).ok, true);
    await Promise.all([endedFirst, endedSecond]);
    assert.equal(application.roomManager.getRoom(created.data.roomCode), null);
    first.disconnect();
    second.disconnect();
    third.disconnect();
  });
});

test('live rate limiter rejects a burst without disconnecting the participant', async () => {
  await withServer(
    async ({ url }) => {
      const first = await connect(url);
      const second = await connect(url);
      const created = await emitAck(first, 'room:create');
      await emitAck(second, 'room:join', { roomCode: created.data.roomCode });
      const packet = {
        version: 1,
        iv: 'AAAAAAAAAAAAAAAA',
        ciphertext: Buffer.alloc(17).toString('base64url'),
      };
      assert.equal((await emitAck(first, 'message:send', packet)).ok, true);
      const rejected = await emitAck(first, 'message:send', packet);
      assert.equal(rejected.error.code, 'RATE_LIMITED');
      assert.equal(first.connected, true);
      first.disconnect();
      second.disconnect();
    },
    { rateLimit: 1 },
  );
});

test('live authorization and ciphertext validation reject stale sessions, outsiders, malformed and oversized packets', async () => {
  await withServer(async ({ application, url }) => {
    const owner = await connect(url);
    const guest = await connect(url);
    const outsider = await connect(url);
    const created = await emitAck(owner, 'room:create');
    const joined = await emitAck(guest, 'room:join', { roomCode: created.data.roomCode });
    const invalidSession = await emitAck(outsider, 'room:join', {
      roomCode: created.data.roomCode,
      sessionId: 'not-a-real-session',
    });
    assert.equal(invalidSession.error.code, 'INVALID_SESSION');

    const packet = {
      version: 1,
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: Buffer.alloc(17).toString('base64url'),
    };
    assert.equal((await emitAck(outsider, 'message:send', packet)).error.code, 'NOT_IN_ROOM');
    assert.equal(
      (await emitAck(owner, 'message:send', { ...packet, iv: 'short' })).error.code,
      'INVALID_MESSAGE',
    );
    const tooLarge = { ...packet, ciphertext: 'A'.repeat(11000) };
    assert.equal((await emitAck(owner, 'message:send', tooLarge)).error.code, 'MESSAGE_TOO_LONG');

    outsider.emit('unregistered:room-mutation', { state: 'ENDED' });
    await sleep(20);
    assert.equal(application.roomManager.getRoom(created.data.roomCode).participants.size, 2);
    assert.ok(joined.data.sessionId);
    owner.disconnect();
    guest.disconnect();
    outsider.disconnect();
  });
});

test('Socket.IO disconnects a client that exceeds the configured frame-size ceiling', async () => {
  await withServer(
    async ({ application, url }) => {
      const owner = await connect(url);
      const oversized = await connect(url);
      const created = await emitAck(owner, 'room:create');
      const disconnected = waitFor(oversized, 'disconnect', 5000);
      oversized.emit('unregistered:event', 'x'.repeat(4000));
      await disconnected;
      assert.equal(application.roomManager.getRoom(created.data.roomCode).participants.size, 1);
      owner.disconnect();
    },
    { maxBuffer: 1024 },
  );
});

test('reconnects a participant with the same session before the grace period expires', async () => {
  await withServer(async ({ application, url }) => {
    const first = await connect(url);
    const created = await emitAck(first, 'room:create');
    const sessionId = created.data.sessionId;
    first.disconnect();
    await sleep(30);
    const replacement = await connect(url);
    const restored = await emitAck(replacement, 'room:join', {
      roomCode: created.data.roomCode,
      sessionId,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.data.reconnected, true);
    assert.equal(restored.data.sessionId, sessionId);
    assert.equal(application.roomManager.getRoom(created.data.roomCode).participants.size, 1);
    replacement.disconnect();
  });
});

test('leaving explicitly releases the seat and notifies the remaining participant', async () => {
  await withServer(async ({ application, url }) => {
    const owner = await connect(url);
    const guest = await connect(url);
    const created = await emitAck(owner, 'room:create');
    await emitAck(guest, 'room:join', { roomCode: created.data.roomCode });
    const left = waitFor(owner, 'participant:left');
    assert.equal((await emitAck(guest, 'room:leave')).ok, true);
    await left;
    assert.equal(application.roomManager.getRoom(created.data.roomCode).participants.size, 1);
    assert.equal((await emitAck(guest, 'room:leave')).ok, true);
    owner.disconnect();
    guest.disconnect();
  });
});

test('limits room actions per socket and caps total live rooms', async () => {
  await withServer(
    async ({ application, url }) => {
      const socket = await connect(url);
      const first = await emitAck(socket, 'room:create');
      assert.equal(first.ok, true);
      assert.equal((await emitAck(socket, 'room:create')).error.code, 'ROOM_LIMIT');
      assert.equal(application.roomManager.rooms.size, 1);
      socket.disconnect();
    },
    { roomActionLimit: 5, maxRooms: 1 },
  );

  await withServer(
    async ({ url }) => {
      const socket = await connect(url);
      await emitAck(socket, 'room:create');
      await emitAck(socket, 'room:create');
      await emitAck(socket, 'room:create');
      await emitAck(socket, 'room:create');
      assert.equal((await emitAck(socket, 'room:create')).error.code, 'RATE_LIMITED');
      socket.disconnect();
    },
    { roomActionLimit: 4 },
  );
});
