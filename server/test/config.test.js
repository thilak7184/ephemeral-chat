import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';

test('development defaults to localhost while preserving exact origin configuration', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.deepEqual(config.clientOrigins, ['http://localhost:5173']);
  assert.equal(config.waitingRoomTtlMs, 600000);
  assert.equal(config.maxMessageLength, 2000);
  assert.equal(config.roomActionRateLimit, 20);
  assert.equal(config.maxRooms, 1000);
  assert.equal(config.serveClient, true);
});

test('production requires a nonempty explicit origin allowlist and normalizes entries', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /CLIENT_ORIGIN/);
  const config = loadConfig({
    NODE_ENV: 'production',
    CLIENT_ORIGIN: 'https://chat.example, https://preview.example/',
  });
  assert.deepEqual(config.clientOrigins, ['https://chat.example', 'https://preview.example']);
  assert.equal(config.isProduction, true);
});
