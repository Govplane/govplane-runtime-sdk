import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { sortKeysDeep } from '../../src/bundle/canonical.js';
import {
  canonicalRecordBytes, hashRecord, linkRecord, verifyRecordChain,
} from '../../src/records/chain.js';
import type { DecisionRecord } from '../../src/records/types.js';

/**
 * Hash chaining.
 *
 * What it must detect: a record removed from the middle, a record altered
 * after the fact. What it must not confuse with tampering: a counted drop,
 * which leaves a `seq` gap with the links intact.
 */

const record = (seq: number): DecisionRecord => ({
  v: 1,
  id: `01JGX2W4K8N7QZ3M5Y6P8R9T${String(seq).padStart(2, '0')}`,
  at: '2026-09-14T14:02:11.417Z',
  seq,
  bundle: {
    checksum: 'sha256:00', signature: { verified: true }, origin: 'local',
  },
  target: { service: 's', resource: 'r', action: 'a' },
  decision: seq % 2 ? 'deny' : 'allow',
  reason: 'rule',
  contextKeysPresent: ['b', 'a'],
});

const chainOf = (seqs: number[]): DecisionRecord[] => {
  let prev: string | null = null;
  return seqs.map((seq) => {
    const r = record(seq);
    prev = linkRecord(r, prev);
    return r;
  });
};

describe('canonical form', () => {
  it('is deep-sorted compact JSON without the hash', () => {
    const r = record(1);
    r.prev = null;
    r.hash = 'sha256:whatever';
    const { hash, ...rest } = r;
    void hash;
    expect(canonicalRecordBytes(r).toString('utf8'))
      .toBe(JSON.stringify(sortKeysDeep(rest)));
    expect(canonicalRecordBytes(r).toString('utf8')).not.toContain('whatever');
  });

  it('hashes those bytes with SHA-256', () => {
    const r = record(1);
    const expected = createHash('sha256').update(canonicalRecordBytes(r)).digest('hex');
    expect(hashRecord(r)).toBe(`sha256:${expected}`);
  });
});

describe('verifyRecordChain', () => {
  it('starts with prev: null and accepts an intact sequence', () => {
    const records = chainOf(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(records[0]?.prev).toBeNull();
    expect(verifyRecordChain(records)).toEqual({ ok: true, records: 50 });
    expect(verifyRecordChain([])).toEqual({ ok: true, records: 0 });
  });

  it('detects a removed record', () => {
    const records = chainOf([1, 2, 3, 4]);
    records.splice(2, 1);
    expect(verifyRecordChain(records)).toEqual({
      ok: false, index: 2, seq: 4, problem: 'broken_link',
    });
  });

  it('detects a mutated record', () => {
    const records = chainOf([1, 2, 3]);
    records[1]!.decision = 'kill_switch';
    expect(verifyRecordChain(records)).toEqual({
      ok: false, index: 1, seq: 2, problem: 'hash_mismatch',
    });
  });

  it('reports a counted drop as a gap, not as tampering', () => {
    // The recorder links the records that reach the sink, so a drop leaves
    // the links intact and only the sequence tells.
    const records = chainOf([1, 2, 5, 6]);
    expect(verifyRecordChain(records)).toEqual({
      ok: false, index: 2, seq: 5, problem: 'gap',
    });
  });

  it('reports records that were never chained', () => {
    expect(verifyRecordChain([record(1)])).toEqual({
      ok: false, index: 0, seq: 1, problem: 'missing_chain',
    });
  });
});
