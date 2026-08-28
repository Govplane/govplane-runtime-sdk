/**
 * Correlated occurrences — the drill-down half of custom telemetry.
 *
 * `event()` and `metric()` aggregate, which is what makes them affordable at
 * request rate. What they cannot do is answer "which decision caused *this*
 * one?", because a trace id is by definition high-cardinality and cannot be a
 * tag on an aggregated series.
 *
 * This keeps whole records instead, one per call, so a business outcome can be
 * joined back to the exact evaluation that produced it. That is the point of
 * §1.3's first claim — and it is also why this is bounded far more tightly than
 * anything else in the module.
 *
 * **This is not a logging facility.** Keep using your own logger for logs. A
 * project's observability storage is metered, and per-occurrence records do not
 * aggregate, so the rate cap below exists to make a mistake here survivable
 * rather than expensive.
 */

import type { LogRecord } from './transport.js';
import type { ObserverErrorHandler } from './types.js';

export type RecordLevel = 'info' | 'warn' | 'error' | 'critical';

export interface RecordOptions {
  /**
   * The decision this outcome followed from, taken from
   * `evaluateWithTrace(...).trace.traceId` or from your own request id.
   *
   * Without it a record is still stored, but it cannot be joined to a decision,
   * which is most of the reason to send one.
   */
  traceId?: string | undefined;
  level?: RecordLevel | undefined;
  /** A stable, machine-readable classifier, e.g. `card_declined`. */
  code?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export const RECORD_LIMITS = {
  /**
   * Records kept per rollup interval.
   *
   * Deliberately small. At the 300s default this is 200 records every five
   * minutes; past it, records are dropped and the drop is reported. The cap is
   * what stops a `record()` call left in a hot path from consuming a project's
   * whole storage quota overnight.
   */
  maxPerInterval: 200,
  maxMessageLength: 1_000,
  /** gp-data allows 16 KB; the headroom keeps a batch from being refused. */
  maxMetadataBytes: 8_000,
  maxCodeLength: 100,
  maxTraceIdLength: 128,
} as const;

export class RecordBuffer {
  private records: LogRecord[] = [];

  private dropped = 0;

  constructor(private readonly onError?: ObserverErrorHandler | undefined) {}

  record(
    message: string,
    options: RecordOptions,
    source: string,
    timestamp: string,
  ): void {
    try {
      if (typeof message !== 'string' || message.trim() === '') {
        this.reject('a record needs a non-empty message');
        return;
      }

      if (this.records.length >= RECORD_LIMITS.maxPerInterval) {
        this.dropped += 1;
        // Reported once per interval rather than per drop: a hot-path call site
        // would otherwise turn one mistake into a second flood, this time
        // through the caller's error handler.
        if (this.dropped === 1) {
          this.reject(
            `more than ${RECORD_LIMITS.maxPerInterval} correlated records in one `
            + 'interval; the rest were dropped. record() keeps one entry per call '
            + 'and does not aggregate — use event() for anything at request rate.',
            false,
          );
        }
        return;
      }

      const metadata = this.normaliseMetadata(options.metadata);
      if (metadata === null) return;

      this.records.push({
        source,
        level: options.level ?? 'info',
        message: message.slice(0, RECORD_LIMITS.maxMessageLength),
        ...(options.code === undefined
          ? {}
          : { code: options.code.slice(0, RECORD_LIMITS.maxCodeLength) }),
        ...(options.traceId === undefined
          ? {}
          : { traceId: options.traceId.slice(0, RECORD_LIMITS.maxTraceIdLength) }),
        metadata,
        timestamp,
      });
    } catch (error) {
      this.onError?.(error, { stage: 'record' });
    }
  }

  private normaliseMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, unknown> | null {
    if (metadata === undefined) return {};

    let serialised: string;
    try {
      serialised = JSON.stringify(metadata);
    } catch {
      // A circular structure, or a BigInt. Either would fail at the wire and
      // take the whole batch with it.
      this.reject('record metadata must be JSON-serialisable');
      return null;
    }

    if (serialised.length > RECORD_LIMITS.maxMetadataBytes) {
      this.reject(
        `record metadata exceeds ${RECORD_LIMITS.maxMetadataBytes} bytes. `
        + 'Metadata is for the few fields you need to understand an outcome, '
        + 'not for a request dump — and everything in it leaves your process.',
      );
      return null;
    }

    return metadata;
  }

  private reject(message: string, count = true): void {
    if (count) this.dropped += 1;
    this.onError?.(new Error(`Govplane: ${message}`), { stage: 'record' });
  }

  /** Returns the buffered records and empties the buffer. */
  drain(): LogRecord[] {
    const out = this.records;
    this.records = [];
    this.dropped = 0;
    return out;
  }

  size(): number {
    return this.records.length;
  }

  droppedCount(): number {
    return this.dropped;
  }
}
