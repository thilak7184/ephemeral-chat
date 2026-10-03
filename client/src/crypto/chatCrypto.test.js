import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  createRoomKey,
  decryptMessage,
  encryptMessage,
  importRoomKey,
  isValidRoomKey,
} from './chatCrypto.js';

globalThis.crypto ??= webcrypto;
globalThis.btoa ??= (value) => Buffer.from(value, 'binary').toString('base64');
globalThis.atob ??= (value) => Buffer.from(value, 'base64').toString('binary');

test('AES-GCM round-trips Unicode plaintext using ciphertext-only packets', async () => {
  const keyText = createRoomKey();
  const key = await importRoomKey(keyText);
  const message = '秘密 — hello 👋';
  const packet = await encryptMessage(key, message);
  assert.equal(packet.version, 1);
  assert.equal('plaintext' in packet, false);
  assert.equal(await decryptMessage(key, packet), message);
});

test('each encrypted message receives a fresh IV', async () => {
  const key = await importRoomKey(createRoomKey());
  const first = await encryptMessage(key, 'same');
  const second = await encryptMessage(key, 'same');
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('invalid keys and tampered ciphertext are rejected', async () => {
  assert.equal(isValidRoomKey('AB1234'), false);
  const key = await importRoomKey(createRoomKey());
  const packet = await encryptMessage(key, 'private');
  const decoded = Buffer.from(packet.ciphertext, 'base64url');
  decoded[decoded.length - 1] ^= 0x01;
  const tampered = { ...packet, ciphertext: decoded.toString('base64url') };
  await assert.rejects(decryptMessage(key, tampered));
});
