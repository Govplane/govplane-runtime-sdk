/**
 * Wires the aggregator to the transport and owns the flush timer.
 *
 * This is the only stateful piece of the module, and it exists mostly to hold
 * the invariants that keep telemetry from becoming the host application's
 * problem: bounded work, an unreferenced timer, and no path by which an error
 * can reach `evaluate()`.
 */

import type { Decision } from '../engine/types.js';
import { bucketStart, createDecisionAggregator, resolveRollupSeconds } from './aggregator.js';
import {
  createTransport, toDataPoints, type Transport, type TransportConfig,
} from './transport.js';
import { createHealthMonitor, type HealthMonitor } from './health.js';
import { CustomAggregator } from './custom.js';
import { RecordBuffer } from './records.js';
import type { DecisionsConfig, ObserverErrorHandler } from './types.js';

export interface RunningObserverConfig {
  transport: Omit<TransportConfig, 'onError'>;
  decisions?: DecisionsConfig | undefined;
  onError?: ObserverErrorHandler | undefined;
  /** Injected in tests, so a flush can be driven without waiting on a clock. */
  now?: (() => number) | undefined;
  /** Injected in tests; when false the caller drives flushing. */
  autoFlush?: boolean | undefined;
  /**
   * Process resource and runtime health sampling.
   *
   * Off unless configured: it costs quota, and per-instance metrics are the
   * dominant term in that cost across a fleet.
   */
  health?: {
    intervalSeconds?: number | undefined;
    instanceId?: string | undefined;
    getBundleState: () => { bundleVersion: number | undefined; loadedAt: string } | undefined;
  } | undefined;
}

export interface RunningObserver {
  /** Called on every evaluation. Must not throw, must not allocate much. */
  record(decision: Decision, bundleVersion: number | undefined): void;
  /** Closes the current bucket and ships it. */
  flush(): Promise<void>;
  /** Stops the timer and ships whatever is buffered. */
  close(): Promise<void>;
  /** Custom application metrics, recorded by the application itself. */
  custom: CustomAggregator;
  /** Correlated occurrences, kept whole rather than aggregated. */
  records: RecordBuffer;
  /** Diagnostics. */
  pending(): number;
  /** One health sample now; empty when health monitoring is not enabled. */
  sampleHealth(): unknown[];
  transport: Transport;
}

const unref = (timer: unknown): void => {
  const t = timer as { unref?: () => void };
  if (typeof t?.unref === 'function') t.unref();
};

export const createObserver = (config: RunningObserverConfig): RunningObserver => {
  const rollupSeconds = resolveRollupSeconds(config.decisions);
  const aggregator = createDecisionAggregator(config.decisions, config.onError);
  const custom = new CustomAggregator(config.onError);
  const records = new RecordBuffer(config.onError);
  const transport = createTransport({ ...config.transport, onError: config.onError });
  const now = config.now ?? Date.now;

  let currentBucket = bucketStart(now(), rollupSeconds);
  let closed = false;
  let inFlight: Promise<void> = Promise.resolve();

  const shipBucket = async (bucketMs: number): Promise<void> => {
    const counters = aggregator.drain();
    const customPoints = custom.drain(bucketMs, config.transport.source);
    const logRecords = records.drain();

    // A separate endpoint, so a separate request. Sent first: if the metric
    // batch is what exhausts the quota, the records that explain it have
    // already landed.
    if (logRecords.length > 0) await transport.sendLogs(logRecords);

    if (counters.length === 0 && customPoints.length === 0) return;

    // One request where possible: decision counters and custom metrics share a
    // bucket boundary, so splitting them would double the round trips and the
    // idempotency keys for no benefit.
    const points = [
      ...toDataPoints(counters, bucketMs, config.transport),
      ...customPoints,
    ];
    await transport.sendPoints(points);
  };

  const flush = async (): Promise<void> => {
    const bucketMs = currentBucket;
    currentBucket = bucketStart(now(), rollupSeconds);
    // Serialised: two overlapping flushes would interleave batches from
    // different buckets and make the idempotency keys meaningless.
    inFlight = inFlight.then(() => shipBucket(bucketMs)).catch((error) => {
      config.onError?.(error, { stage: 'rollup' });
    });
    return inFlight;
  };

  let health: HealthMonitor | undefined;
  if (config.health) {
    health = createHealthMonitor({
      source: config.transport.source,
      getBundleState: config.health.getBundleState,
      ...(config.health.intervalSeconds === undefined
        ? {}
        : { intervalSeconds: config.health.intervalSeconds }),
      ...(config.health.instanceId === undefined
        ? {}
        : { instanceId: config.health.instanceId }),
      ...(config.onError === undefined ? {} : { onError: config.onError }),
    });
    if (config.autoFlush !== false) {
      // Health samples ship on their own cadence rather than waiting for the
      // decision rollup: memory pressure is worth knowing about sooner than a
      // five-minute decision bucket would tell you.
      health.start((points) => { void transport.sendPoints(points); });
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (config.autoFlush !== false) {
    timer = setInterval(() => { void flush(); }, rollupSeconds * 1000);
    // The single most important line in this file. A telemetry interval that
    // keeps the event loop alive stops a CLI or a job from ever exiting, and no
    // test that does not actually wait for process exit will catch it.
    unref(timer);
  }

  return {
    record(decision, bundleVersion) {
      if (closed) return;
      aggregator.record(decision, bundleVersion);
    },
    flush,
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      health?.stop();
      await flush();
    },
    sampleHealth: () => health?.sample() ?? [],
    custom,
    records,
    pending: () => aggregator.size() + custom.size() + records.size(),
    transport,
  };
};
