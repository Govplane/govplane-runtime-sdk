import { randomBytes } from 'node:crypto';

/**
 * ULIDs for record ids.
 *
 * 48 bits of millisecond time and 80 bits of randomness, Crockford base32,
 * 26 characters. Two properties matter here and both are guaranteed: ids sort
 * in creation order across time, and within one millisecond the random half
 * is incremented rather than redrawn, so two records from the same tick still
 * sort in the order they were made. A UUID has neither property, and a record
 * stream is exactly where they are wanted.
 *
 * Randomness comes from a pooled `randomBytes`, one call per hundred-odd ids
 * rather than one per id; `evaluate()` is the caller and pays for this.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_BYTES = 10;
const POOL_IDS = 128;

const encodeTime = (ms: number): string => {
  let out = '';
  let rest = ms;
  for (let i = 0; i < 10; i += 1) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
};

/** 80 bits → 16 characters of base32, straight from the bytes. */
const encodeRandom = (bytes: Uint8Array): string => {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < RANDOM_BYTES; i += 1) {
    acc = (acc << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
  }
  return out;
};

const increment = (bytes: Uint8Array): void => {
  for (let i = RANDOM_BYTES - 1; i >= 0; i -= 1) {
    if (bytes[i]! < 255) {
      bytes[i] = bytes[i]! + 1;
      return;
    }
    bytes[i] = 0;
  }
};

export const createUlidFactory = (now: () => number = Date.now): (() => string) => {
  const pool = new Uint8Array(RANDOM_BYTES * POOL_IDS);
  let poolOffset = pool.length;
  let lastMs = -1;
  const lastRandom = new Uint8Array(RANDOM_BYTES);

  const draw = (): void => {
    if (poolOffset >= pool.length) {
      pool.set(randomBytes(pool.length));
      poolOffset = 0;
    }
    lastRandom.set(pool.subarray(poolOffset, poolOffset + RANDOM_BYTES));
    poolOffset += RANDOM_BYTES;
  };

  return () => {
    const ms = Math.max(0, Math.floor(now()));
    if (ms === lastMs) {
      increment(lastRandom);
    } else {
      lastMs = ms;
      draw();
    }
    return encodeTime(ms) + encodeRandom(lastRandom);
  };
};
