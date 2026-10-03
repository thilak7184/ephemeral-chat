import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../src/rooms/RoomManager.js';

class FakeClock {
  now = 0;
  nextId = 1;
  tasks = new Map();
  schedule = (fn, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { fn, at: this.now + delay });
    return id;
  };
  cancel = (id) => this.tasks.delete(id);
  async advance(ms) {
    this.now += ms;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.now)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      due[1].fn();
      await Promise.resolve();
    }
  }
}

const makeManager = (clock = new FakeClock(), overrides = {}) => ({
  manager: new RoomManager({
    waitingRoomTtlMs: 1000,
    activeRoomIdleTtlMs: 2000,
    disconnectGraceMs: 500,
    now: () => clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    ...overrides,
  }),
  clock,
});

test('creates cryptographic room/session identifiers and normalizes codes', () => {
  const { manager } = makeManager();
  const created = manager.createRoom('socket-a');
  assert.equal(created.ok, true);
  assert.match(created.roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(created.sessionId.length >= 40);
  assert.equal(created.state, 'WAITING');
  assert.equal(manager.getRoom(created.roomCode.toLowerCase())?.roomCode, created.roomCode);
});

test('refuses room creation after reaching the configured room cap', () => {
  const { manager } = makeManager(undefined, { maxRooms: 1 });
  const owner = manager.createRoom('socket-a');
  assert.equal(owner.ok, true);
  assert.deepEqual(manager.createRoom('socket-b'), { ok: false, code: 'ROOM_LIMIT' });
});

test('allows two participants and rejects an additional participant', () => {
  const { manager } = makeManager();
  const first = manager.createRoom('socket-a');
  const second = manager.joinRoom({ roomCode: first.roomCode.toLowerCase(), socketId: 'socket-b' });
  assert.equal(second.ok, true);
  assert.equal(second.state, 'ACTIVE');
  assert.equal(second.participantCount, 2);
  assert.equal(
    manager.joinRoom({ roomCode: first.roomCode, socketId: 'socket-c' }).code,
    'ROOM_FULL',
  );
});

test('two simultaneous join attempts cannot exceed the two-seat limit', async () => {
  const { manager } = makeManager();
  const owner = manager.createRoom('owner');
  const attempts = await Promise.all([
    Promise.resolve().then(() =>
      manager.joinRoom({ roomCode: owner.roomCode, socketId: 'guest-1' }),
    ),
    Promise.resolve().then(() =>
      manager.joinRoom({ roomCode: owner.roomCode, socketId: 'guest-2' }),
    ),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.ok).length, 1);
  assert.equal(attempts.filter((attempt) => attempt.code === 'ROOM_FULL').length, 1);
  assert.equal(manager.getRoom(owner.roomCode).participants.size, 2);
});

test('rejects malformed and unsupported room codes before lookup', () => {
  const { manager } = makeManager();
  assert.equal(manager.joinRoom({ roomCode: '1L0O!!', socketId: 'x' }).code, 'INVALID_ROOM_CODE');
  assert.equal(manager.joinRoom({ roomCode: 123456, socketId: 'x' }).code, 'INVALID_ROOM_CODE');
  assert.equal(manager.joinRoom({ roomCode: 'ABCDEF', socketId: 'x' }).code, 'ROOM_NOT_FOUND');
});

test('restores the same seat during grace and cancels its removal', async () => {
  const { manager, clock } = makeManager();
  const owner = manager.createRoom('socket-a');
  manager.disconnect(owner.roomCode, owner.sessionId, 'socket-a');
  await clock.advance(300);
  const restored = manager.joinRoom({
    roomCode: owner.roomCode,
    sessionId: owner.sessionId,
    socketId: 'socket-a2',
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.reconnected, true);
  assert.equal(restored.sessionId, owner.sessionId);
  await clock.advance(300);
  assert.equal(manager.getRoom(owner.roomCode).participants.size, 1);
  assert.equal(
    manager.getRoom(owner.roomCode).participants.get(owner.sessionId).socketId,
    'socket-a2',
  );
});

test('frees a disconnected seat after grace and returns a surviving active room to waiting', async () => {
  const { manager, clock } = makeManager();
  const owner = manager.createRoom('socket-a');
  const guest = manager.joinRoom({ roomCode: owner.roomCode, socketId: 'socket-b' });
  manager.disconnect(owner.roomCode, owner.sessionId, 'socket-a');
  await clock.advance(501);
  const room = manager.getRoom(owner.roomCode);
  assert.equal(room.state, 'WAITING');
  assert.equal(room.participants.size, 1);
  assert.equal(room.participants.has(owner.sessionId), false);
  assert.equal(room.participants.has(guest.sessionId), true);
  assert.equal(
    manager.joinRoom({
      roomCode: owner.roomCode,
      sessionId: owner.sessionId,
      socketId: 'stale-owner',
    }).code,
    'INVALID_SESSION',
  );
});

test('expires empty waiting rooms and destroys their participant data', async () => {
  const expired = [];
  const { manager, clock } = makeManager(undefined, {
    onRoomExpired: (event) => expired.push(event.roomCode),
  });
  const owner = manager.createRoom('socket-a');
  await clock.advance(1001);
  assert.equal(manager.getRoom(owner.roomCode), null);
  assert.deepEqual(expired, [owner.roomCode]);
});

test('refreshes active idle expiry on authenticated activity', async () => {
  const { manager, clock } = makeManager();
  const owner = manager.createRoom('socket-a');
  manager.joinRoom({ roomCode: owner.roomCode, socketId: 'socket-b' });
  await clock.advance(1500);
  const touched = manager.joinRoom({
    roomCode: owner.roomCode,
    sessionId: owner.sessionId,
    socketId: 'socket-a',
  });
  assert.equal(touched.ok, true);
  await clock.advance(1500);
  assert.ok(manager.getRoom(owner.roomCode));
  await clock.advance(501);
  assert.equal(manager.getRoom(owner.roomCode), null);
});

test('end chat invalidates sessions, cancels timers, and prevents room reuse', () => {
  const { manager } = makeManager();
  const owner = manager.createRoom('socket-a');
  const guest = manager.joinRoom({ roomCode: owner.roomCode, socketId: 'socket-b' });
  const ended = manager.endRoom(owner.roomCode, guest.sessionId);
  assert.equal(ended.ok, true);
  assert.deepEqual(new Set(ended.socketIds), new Set(['socket-a', 'socket-b']));
  assert.equal(manager.getRoom(owner.roomCode), null);
  assert.equal(
    manager.joinRoom({ roomCode: owner.roomCode, socketId: 'socket-c' }).code,
    'ROOM_NOT_FOUND',
  );
});

test('explicit leave frees a seat and destroys an empty room', () => {
  const { manager } = makeManager();
  const owner = manager.createRoom('socket-a');
  const guest = manager.joinRoom({ roomCode: owner.roomCode, socketId: 'socket-b' });
  assert.deepEqual(manager.leaveRoom(owner.roomCode, guest.sessionId, 'wrong-socket'), {
    ok: false,
    code: 'NOT_IN_ROOM',
  });
  assert.equal(manager.leaveRoom(owner.roomCode, guest.sessionId, 'socket-b').participantCount, 1);
  assert.equal(manager.getRoom(owner.roomCode).state, 'WAITING');
  assert.equal(manager.leaveRoom(owner.roomCode, owner.sessionId, 'socket-a').participantCount, 0);
  assert.equal(manager.getRoom(owner.roomCode), null);
});

test('authenticated touch refreshes active idle expiry', async () => {
  const { manager, clock } = makeManager();
  const owner = manager.createRoom('socket-a');
  manager.joinRoom({ roomCode: owner.roomCode, socketId: 'socket-b' });
  await clock.advance(1500);
  assert.equal(manager.touch(owner.roomCode, owner.sessionId, 'socket-a'), true);
  assert.equal(manager.touch(owner.roomCode, owner.sessionId, 'stale-socket'), false);
  await clock.advance(1500);
  assert.ok(manager.getRoom(owner.roomCode));
});
