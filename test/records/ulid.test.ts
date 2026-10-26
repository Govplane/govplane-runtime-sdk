import { describe, expect, it } from '@jest/globals';
import { createUlidFactory } from '../../src/records/ulid.js';

/**
 * Record ids.
 *
 * Two properties are relied on downstream: ids sort in creation order across
 * time, and within one millisecond they still sort in creation order. Both
 * are checked with an injected clock, so neither depends on the test being
 * fast or slow.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('createUlidFactory', () => {
  it('produces 26 Crockford base32 characters', () => {
    const next = createUlidFactory();
    for (let i = 0; i < 300; i += 1) expect(next()).toMatch(ULID);
  });

  it('encodes the millisecond in the first ten characters', () => {
    const next = createUlidFactory(() => 0);
    expect(next().slice(0, 10)).toBe('0000000000');
    const later = createUlidFactory(() => 1_700_000_000_000);
    expect(later().slice(0, 10)).toBe('01HF7YAT00');
  });

  it('sorts by time across milliseconds', () => {
    let clock = 1_000;
    const next = createUlidFactory(() => clock);
    const first = next();
    clock += 1;
    const second = next();
    expect(second > first).toBe(true);
  });

  it('is monotonic within one millisecond', () => {
    const next = createUlidFactory(() => 42);
    const ids = Array.from({ length: 500 }, () => next());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps going past the random pool', () => {
    const next = createUlidFactory();
    const ids = new Set(Array.from({ length: 1_000 }, () => next()));
    expect(ids.size).toBe(1_000);
  });
});
