const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const KEY_BYTES = 32;
const IV_BYTES = 12;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('The invite key is malformed.');
  const base64 =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('The invite key is malformed.');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createRoomKey() {
  const rawKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return bytesToBase64Url(rawKey);
}

export async function importRoomKey(keyText) {
  const rawKey = base64UrlToBytes(keyText);
  if (rawKey.byteLength !== KEY_BYTES)
    throw new Error('The invite key is invalid. Use the full invite link.');
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptMessage(cryptoKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    cryptoKey,
    encoder.encode(plaintext),
  );
  return {
    version: 1,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
  };
}

export async function decryptMessage(cryptoKey, packet) {
  if (!packet || packet.version !== 1) throw new Error('Unsupported encrypted message.');
  const iv = base64UrlToBytes(packet.iv);
  const ciphertext = base64UrlToBytes(packet.ciphertext);
  if (iv.byteLength !== IV_BYTES || ciphertext.byteLength < 16)
    throw new Error('Invalid encrypted message.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    cryptoKey,
    ciphertext,
  );
  return decoder.decode(plaintext);
}

export function isValidRoomKey(keyText) {
  try {
    return base64UrlToBytes(keyText).byteLength === KEY_BYTES;
  } catch {
    return false;
  }
}
