/**
 * Builds the pieces a client needs to report telemetry.
 *
 * Note what this does *not* do: it never wraps `evaluate`. An earlier shape did,
 * and it was wrong — `evaluate` can return a boolean, a 0/1 or a bare effect
 * depending on its options, and those shapes have already discarded the
 * `policyKey` and `ruleId` a counter needs. Recovering them meant either
 * evaluating twice or reimplementing the engine's output shaping here.
 *
 * Instead the engine gained an `onDecision` hook, which fires with the unshaped
 * decision at the one point where it exists. This module supplies the callback;
 * the engine decides when to call it.
 */

import type { Decision } from '../engine/types.js';
import { createObserver, type RunningObserver } from './createObserver.js';
import { resolveInstanceId } from './instance.js';
import type { EventOptions, MetricOptions } from './custom.js';
import type { RecordOptions } from './records.js';
import type { DecisionsConfig, ObserverErrorHandler } from './types.js';
import { disabledCategoryMessage, type ResolvedIngestion } from './ingestion.js';

/** What `client.observe` exposes to the application. */
export interface ClientObserver {
  /**
   * Counts something that happened.
   *
   * ```ts
   * client.observe.event('payment.failed', {
   *   category: 'error_rate',
   *   tags: { provider: 'stripe', code: 'card_declined' },
   * });
   * ```
   *
   * Summed within the rollup interval and shipped as one point, so calling it
   * per request costs a map increment rather than a request.
   *
   * Tags are dimensions to group by, not a place for request detail: keep them
   * few and low-cardinality. A user id as a tag value is both a privacy problem
   * and a cardinality problem, and oversized tags are dropped rather than sent.
   */
  event(name: string, options?: EventOptions): void;

  /**
   * Records a measurement.
   *
   * ```ts
   * client.observe.metric('checkout.queue_depth', depth, { unit: 'count' });
   * ```
   *
   * Reduced within the rollup interval — `last` by default, or `avg`/`min`/
   * `max`/`sum` — and shipped as one point. gp-data's alert rules then
   * aggregate across intervals.
   */
  metric(name: string, value: number, options?: MetricOptions): void;

  /**
   * Keeps one whole record, correlated to a decision.
   *
   * ```ts
   * const { decision, trace } = client.evaluateWithTrace(input, { level: 'full' });
   * if (paymentFailed) {
   *   client.observe?.record('payment declined at capture', {
   *     traceId: trace?.traceId,
   *     level: 'error',
   *     code: 'card_declined',
   *     metadata: { provider: 'stripe' },
   *   });
   * }
   * ```
   *
   * Unlike `event` and `metric` this does **not** aggregate: one call is one
   * stored record. Use it for the small number of outcomes you need to drill
   * into, not at request rate — there is a hard cap per interval, and anything
   * past it is dropped and reported.
   */
  record(message: string, options?: RecordOptions): void;

  /** Ships the current bucket now. */
  flush(): Promise<void>;
  /** Stops the flush timer and ships whatever is buffered. */
  close(): Promise<void>;
  /** Series currently buffered, decisions and custom metrics together. */
  pending(): number;
}

export interface ClientObserverOptions {
  endpoint: string;
  runtimeKey: string;
  projectId: string;
  env: string;
  source: string;
  instanceId?: string | undefined;
  decisions?: DecisionsConfig | undefined;
  onError?: ObserverErrorHandler | undefined;
  fetchImpl?: typeof fetch | undefined;
  autoFlush?: boolean | undefined;
  /**
   * Which streams to send.
   *
   * Resolved by the caller rather than here, so that the one place deciding
   * what a customer is billed for is a pure function with its own tests.
   */
  ingestion: ResolvedIngestion;
}

export interface AttachedObserver {
  /** Passed to the engine as `onDecision`. */
  onDecision: (decision: Decision) => void;
  handle: ClientObserver;
}

/**
 * @param getBundleVersion Read lazily, because the bundle in force changes when
 * a background reload lands. Capturing it once would tag every later decision
 * with the version that happened to be loaded at construction, which is exactly
 * the attribution a publish watch depends on.
 */
export const createClientObserver = (
  options: ClientObserverOptions,
  getBundleVersion: () => number | undefined,
  getBundleState?: () => { bundleVersion: number | undefined; loadedAt: string } | undefined,
): AttachedObserver => {
  const instanceId = options.instanceId ?? resolveInstanceId();

  /**
   * Said once, not once per call.
   *
   * `event` and `metric` are designed to be called at request rate. A warning
   * on each would turn a configuration mistake into a log flood, which is a
   * worse problem than the one it reports.
   */
  const warned = new Set<string>();
  const warnDisabled = (method: string): void => {
    if (warned.has(method)) return;
    warned.add(method);
    options.onError?.(new Error(disabledCategoryMessage(method)), { stage: 'record' });
  };

  const observer: RunningObserver = createObserver({
    transport: {
      endpoint: options.endpoint,
      runtimeKey: options.runtimeKey,
      projectId: options.projectId,
      env: options.env,
      source: options.source,
      // Decision counters carry the instance tag only on request: it multiplies
      // series count by fleet size, and a fleet total is the usual question.
      // Health metrics below always carry it, because they describe one process.
      ...(options.decisions?.perInstance ? { instanceId } : {}),
      fetchImpl: options.fetchImpl,
    },
    decisions: options.decisions,
    onError: options.onError,
    autoFlush: options.autoFlush,
    ...(options.ingestion.performance && getBundleState
      ? {
        health: {
          getBundleState,
          ...(options.ingestion.performanceIntervalSeconds === undefined
            ? {}
            : { intervalSeconds: options.ingestion.performanceIntervalSeconds }),
          ...(instanceId === undefined ? {} : { instanceId }),
        },
      }
      : {}),
  });

  const version = (): number | undefined => {
    try {
      return getBundleVersion();
    } catch {
      // Reading the loaded bundle must never be the reason an evaluation fails.
      return undefined;
    }
  };

  const { custom } = options.ingestion;

  return {
    onDecision: (decision) => observer.record(decision, version()),
    handle: {
      /**
       * A no-op rather than an absent method when the category is off.
       *
       * Leaving `client.observe` undefined would make an application that calls
       * it throw a TypeError from inside a request handler — telemetry
       * configuration taking down the host, which is the one thing this module
       * may never do. It stays callable and says so once instead.
       */
      event: (name, opts) => {
        if (!custom) return warnDisabled('event');
        observer.custom.event(name, opts);
      },
      metric: (name, value, opts) => {
        if (!custom) return warnDisabled('metric');
        observer.custom.metric(name, value, opts);
      },
      record: (message, opts) => {
        if (!custom) return warnDisabled('record');
        observer.records.record(
          message,
          opts ?? {},
          options.source,
          new Date().toISOString(),
        );
      },
      flush: () => observer.flush(),
      close: () => observer.close(),
      pending: () => observer.pending(),
    },
  };
};
