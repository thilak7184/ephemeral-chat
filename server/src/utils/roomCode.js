import { randomInt } from 'node:crypto';

// Excludes visually ambiguous 0/O and 1/I characters.
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode() {
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  if ([...code].some((character) => !ROOM_ALPHABET.includes(character))) return null;
  return code;
}
