import type { BundleOrigin } from '../bundle/types.js';
import type { ApprovalDescriptor, Decision, DecisionReason, Target } from '../engine/types.js';

/**
 * Decision records.
 *
 * A record is the SDK's own account of one evaluation: what was asked, what
 * was answered, and — the part that makes it evidence rather than assertion —
 * exactly which bundle answered. The host supplies a sink; the SDK supplies
 * records to it, in batches, off the evaluation path.
 *
 * The shape is versioned (`v`) and pinned by a golden fixture in the test
 * suite, so a change to it is a deliberate one.
 */

export interface DecisionRecordBundle {
  /** The bundle's revision counter, when it carries one. */
  version?: number;
  generatedAt?: string;
  /** The embedded checksum, or one computed from the canonical payload. */
  checksum: string;
  /** `verified` is false only when the client was built with `allowUnsigned`. */
  signature: { algorithm?: string; verified: boolean };
  origin: BundleOrigin;
}

export interface DecisionRecord {
  v: 1;
  /** ULID: lexicographically sortable, monotonic within a process. */
  id: string;
  /** ISO 8601, when the decision was made. */
  at: string;
  /** Per-client counter. A gap is a drop, and drops are counted in `status()`. */
  seq: number;
  bundle: DecisionRecordBundle;
  /** Present for a target-addressed evaluation. */
  target?: Target;
  /** Present instead of `target` when a rule was addressed by name. */
  ruleAddressed?: { ruleId: string; policyKey?: string };
  decision: Decision['decision'];
  reason: DecisionReason;
  policyKey?: string;
  ruleId?: string;
  // Effect payloads, when the decision carried one. Policy data, not input.
  killSwitch?: { service: string; reason?: string };
  throttle?: { limit: number; windowSeconds: number; key: string };
  approval?: ApprovalDescriptor;
  value?: string;
  /** Present when `reason` is `signal_missing`. */
  missingSignals?: string[];
  /** Only the keys named in `include.context`, and only those that were supplied. */
  context?: Record<string, unknown>;
  /** Every context key that was supplied — names only, never values. */
  contextKeysPresent: string[];
  /** The previous record's `hash`, or `null` for the first record. Chain only. */
  prev?: string | null;
  /** SHA-256 of this record's canonical serialisation, `hash` excluded. Chain only. */
  hash?: string;
}

export type DecisionRecordSink = (records: DecisionRecord[]) => void | Promise<void>;

export type RecordOverflow = 'drop-oldest' | 'drop-newest' | 'block-never';

export interface RecordConfig {
  /**
   * Receives batches. Called on a microtask or timer, never inside
   * `evaluate()`. A throw or rejection is reported through `onError` with code
   * `RECORD_SINK_ERROR` and never reaches the caller of `evaluate()`.
   */
  sink: DecisionRecordSink;
  include?: {
    /**
     * Context keys whose *values* are recorded. Nothing is recorded that is
     * not named here; there is no wildcard. Keys the PII heuristic flags are
     * refused at construction when a context policy is in force.
     */
    context?: string[];
  };
  batch?: {
    /** Flush when this many records are waiting. Default 100. */
    maxRecords?: number;
    /** Flush this long after the first record of a batch arrives. Default 1000. */
    maxDelayMs?: number;
  };
  /** Records held while the sink is busy. Default `batch.maxRecords × 4`. */
  maxQueue?: number;
  /**
   * What to do when the queue is full. `block-never` is `drop-oldest` under a
   * name that says out loud what none of the modes do.
   */
  overflow?: RecordOverflow;
  /** Link each record to the previous one by hash. Tamper-evident, not tamper-proof. */
  chain?: boolean;
  sample?: {
    /** Fraction of decisions recorded, 0..1. Default 1. */
    rate?: number;
    /** Decisions always recorded regardless of `rate`. */
    always?: Decision['decision'][];
  };
}

export interface RecordStatus {
  enabled: boolean;
  queued: number;
  emitted: number;
  dropped: number;
  lastError: { code: string; message: string; at: string } | null;
}

/** The configuration after validation, with every default applied. */
export interface ResolvedRecordConfig {
  sink: DecisionRecordSink;
  includeContext: string[];
  maxRecords: number;
  maxDelayMs: number;
  maxQueue: number;
  overflow: 'drop-oldest' | 'drop-newest';
  chain: boolean;
  sampleRate: number;
  always: Set<Decision['decision']>;
}

/** What the recorder needs to know about the bundle in force. */
export type BundleSnapshot = DecisionRecordBundle;
