import { GovplaneError } from '../errors/errors.js';
import type { Decision, PolicyEngineEvaluateInput } from '../engine/types.js';
import { linkRecord } from './chain.js';
import { buildDecisionRecord } from './record.js';
import { REAL_TIMERS } from './timers.js';
import type { TimerHandle, Timers } from './timers.js';
import { createUlidFactory } from './ulid.js';
import type {
  BundleSnapshot, DecisionRecord, RecordStatus, ResolvedRecordConfig,
} from './types.js';

/**
 * The recorder: a bounded queue between `evaluate()` and the sink.
 *
 * Same shape as the engine's `TraceDispatcher` — enqueue on the hot path,
 * drain on a microtask, never await where a decision is being made — with
 * three things that module does not need: batches, a delay timer, and
 * counters. The counters are not decoration. An audit trail that loses
 * records silently is worse than none, so every drop is counted and every
 * sink failure is reported.
 *
 * Invariants, from the observability spec §5.2: enqueue only on the decision
 * path; every failure to `onError` and swallowed; a hard queue maximum with an
 * explicit overflow policy; a bounded shutdown flush.
 */

export interface RecorderDeps {
  onError: (error: unknown) => void;
  timers?: Timers;
  /** Injectable for deterministic sampling in tests. */
  random?: () => number;
}

export interface Recorder {
  /** Called inside `evaluate()`. Never throws, never awaits. */
  observe(decision: Decision, input: PolicyEngineEvaluateInput, snapshot: BundleSnapshot): void;
  /** Delivers everything queued and resolves once the sink has taken it. */
  flush(): Promise<void>;
  /** Flushes with a deadline, then stops accepting records. */
  close(timeoutMs: number): Promise<void>;
  status(): RecordStatus;
}

export const DISABLED_RECORD_STATUS: RecordStatus = Object.freeze({
  enabled: false, queued: 0, emitted: 0, dropped: 0, lastError: null,
});

export const createRecorder = (config: ResolvedRecordConfig, deps: RecorderDeps): Recorder => {
  const timers = deps.timers ?? REAL_TIMERS;
  const random = deps.random ?? Math.random;
  const nextId = createUlidFactory(timers.now);

  const queue: DecisionRecord[] = [];
  let seq = 0;
  let emitted = 0;
  let dropped = 0;
  let lastError: RecordStatus['lastError'] = null;
  let lastHash: string | null = null;
  let closed = false;

  let draining = false;
  // Whether the current drain should also ship a partial final batch. A drain
  // kicked by a full batch ships full batches only and leaves the remainder
  // to the delay timer; a drain kicked by the timer or by `flush()` ships all.
  let drainAll = false;
  let timer: TimerHandle | undefined;
  let flushWaiters: (() => void)[] = [];

  // `toISOString()` is the most expensive thing on the observe path, and a
  // process at 10k evaluations a second asks for the same millisecond ten
  // times over. One string per millisecond.
  let lastAtMs = -1;
  let lastAt = '';
  const isoNow = (): string => {
    const ms = timers.now();
    if (ms !== lastAtMs) {
      lastAtMs = ms;
      lastAt = new Date(ms).toISOString();
    }
    return lastAt;
  };

  const report = (error: unknown): void => {
    try {
      deps.onError(error);
    } catch {
      // The host's error handler is the last line; nothing to do if it throws.
    }
  };

  const settleWaitersIfIdle = (): void => {
    if (draining || queue.length) return;
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const waiter of waiters) waiter();
  };

  const hasBatch = (): boolean => (
    drainAll ? queue.length > 0 : queue.length >= config.maxRecords
  );

  const drain = async (): Promise<void> => {
    try {
      while (hasBatch()) {
        const batch = queue.splice(0, config.maxRecords);
        // Hashing happens here, on the drain path, and the chain links the
        // records that reach the sink: a dropped record leaves a `seq` gap,
        // not a broken link, so a verifier can tell the two apart.
        if (config.chain) {
          for (const record of batch) lastHash = linkRecord(record, lastHash);
        }
        try {
          await config.sink(batch);
          emitted += batch.length;
        } catch (cause) {
          dropped += batch.length;
          const message = cause instanceof Error ? cause.message : String(cause);
          lastError = {
            code: 'RECORD_SINK_ERROR',
            message,
            at: new Date(timers.now()).toISOString(),
          };
          report(new GovplaneError(
            `Decision record sink failed; ${batch.length} record(s) lost: ${message}`,
            'RECORD_SINK_ERROR',
            { cause, records: batch.length },
          ));
        }
      }
    } finally {
      draining = false;
      if (flushWaiters.length && queue.length) {
        // A flush arrived mid-drain: go round again and take everything.
        kick(true); // eslint-disable-line @typescript-eslint/no-use-before-define
      } else {
        drainAll = false;
        settleWaitersIfIdle();
        if (queue.length >= config.maxRecords) {
          kick(false); // eslint-disable-line @typescript-eslint/no-use-before-define
        } else if (queue.length) {
          armTimer(); // eslint-disable-line @typescript-eslint/no-use-before-define
        }
      }
    }
  };

  const kick = (all: boolean): void => {
    drainAll = drainAll || all;
    if (draining) return;
    if (timer !== undefined) {
      timers.clearTimer(timer);
      timer = undefined;
    }
    if (!queue.length) {
      drainAll = false;
      settleWaitersIfIdle();
      return;
    }
    draining = true;
    queueMicrotask(() => { void drain(); });
  };

  const armTimer = (): void => {
    if (timer !== undefined || draining) return;
    timer = timers.setTimer(() => {
      timer = undefined;
      kick(true);
    }, config.maxDelayMs);
  };

  const enqueue = (record: DecisionRecord): void => {
    if (queue.length >= config.maxQueue) {
      dropped += 1;
      if (config.overflow === 'drop-newest') return;
      queue.shift();
    }
    queue.push(record);
    if (queue.length >= config.maxRecords) {
      kick(false);
    } else {
      armTimer();
    }
  };

  const shouldRecord = (decision: Decision): boolean => {
    if (config.always.has(decision.decision)) return true;
    if (config.sampleRate >= 1) return true;
    if (config.sampleRate <= 0) return false;
    return random() < config.sampleRate;
  };

  return {
    observe(decision, input, snapshot) {
      try {
        if (closed) {
          dropped += 1;
          return;
        }
        if (!shouldRecord(decision)) return;
        // `seq` is taken after sampling, so a gap in the sequence always means
        // a record was dropped, never that one was not sampled.
        seq += 1;
        enqueue(buildDecisionRecord({
          decision,
          input,
          snapshot,
          includeContext: config.includeContext,
          seq,
          id: nextId(),
          at: isoNow(),
        }));
      } catch (error) {
        report(error);
      }
    },

    flush() {
      if (!draining && !queue.length) return Promise.resolve();
      return new Promise<void>((resolve) => {
        flushWaiters.push(resolve);
        kick(true);
      });
    },

    async close(timeoutMs) {
      if (timer !== undefined) {
        timers.clearTimer(timer);
        timer = undefined;
      }
      let deadline: TimerHandle | undefined;
      const timeout = new Promise<void>((resolve) => {
        deadline = timers.setTimer(resolve, timeoutMs);
      });
      try {
        await Promise.race([this.flush(), timeout]);
      } finally {
        if (deadline !== undefined) timers.clearTimer(deadline);
        closed = true;
      }
    },

    status() {
      return {
        enabled: true, queued: queue.length, emitted, dropped, lastError,
      };
    },
  };
};
