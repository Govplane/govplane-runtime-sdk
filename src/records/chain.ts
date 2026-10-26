import { createHash } from 'node:crypto';
import { sortKeysDeep } from '../bundle/canonical.js';
import type { DecisionRecord } from './types.js';

/**
 * Hash chaining.
 *
 * Each record carries the hash of the previous one, so a verifier walking a
 * stored sequence can see that a record was removed or altered afterwards.
 * That is the whole claim. Whoever controls the process can produce a valid
 * chain of anything, so this is tamper-evident storage, not non-repudiation;
 * the latter needs a key the host does not hold.
 *
 * Canonical form is the bundle's: keys sorted at every depth, no whitespace,
 * UTF-8, and `hash` itself left out.
 */

export const canonicalRecordBytes = (record: DecisionRecord): Buffer => {
  const { hash, ...rest } = record;
  void hash;
  return Buffer.from(JSON.stringify(sortKeysDeep(rest)), 'utf8');
};

export const hashRecord = (record: DecisionRecord): string => (
  `sha256:${createHash('sha256').update(canonicalRecordBytes(record)).digest('hex')}`
);

/** Sets `prev` and then `hash`, in place, and returns the new hash. */
export const linkRecord = (record: DecisionRecord, prev: string | null): string => {
  const linked = record;
  linked.prev = prev;
  delete linked.hash;
  linked.hash = hashRecord(linked);
  return linked.hash;
};

export type ChainProblem = 'missing_chain' | 'hash_mismatch' | 'broken_link' | 'gap';

export type ChainVerification =
  | { ok: true; records: number }
  | { ok: false; index: number; seq: number; problem: ChainProblem };

/**
 * Walks a sequence of records as the sink received them.
 *
 * `gap` is reported when `seq` skips while the links are intact: that is what
 * a counted drop looks like, and it is distinguishable from tampering on
 * purpose. `broken_link` means a record between two others is not the one
 * `prev` names; `hash_mismatch` means a record's own content changed.
 */
export const verifyRecordChain = (records: DecisionRecord[]): ChainVerification => {
  let expectedPrev: string | null | undefined;
  let lastSeq: number | undefined;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.hash === undefined || record.prev === undefined) {
      return { ok: false, index, seq: record.seq, problem: 'missing_chain' };
    }
    if (hashRecord(record) !== record.hash) {
      return { ok: false, index, seq: record.seq, problem: 'hash_mismatch' };
    }
    if (expectedPrev !== undefined && record.prev !== expectedPrev) {
      return { ok: false, index, seq: record.seq, problem: 'broken_link' };
    }
    if (lastSeq !== undefined && record.seq !== lastSeq + 1) {
      return { ok: false, index, seq: record.seq, problem: 'gap' };
    }
    expectedPrev = record.hash;
    lastSeq = record.seq;
  }

  return { ok: true, records: records.length };
};
