import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number, length: number): string {
  let value = now;
  let output = '';
  for (let i = 0; i < length; i += 1) {
    const mod = value % 32;
    output = ENCODING[mod] + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += ENCODING[bytes[i]! % 32];
  }
  return output;
}

export function ulid(now = Date.now()): string {
  return `${encodeTime(now, 10)}${encodeRandom(16)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
