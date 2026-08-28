/**
 * Public types for the observability module.
 *
 * Everything here is additive. A client that does not configure `observe`
 * behaves exactly as it did before this module existed.
 */

import type { Decision } from '../engine/types.js';

/** A decision outcome, as it appears in a series key. */
export type DecisionOutcome = Decision['decision'];

/**
 * One rolled-up counter.
 *
 * The key is deliberately low-cardinality: policy and rule identifiers, the
 * outcome, and the bundle version that produced it. No request-scoped value
 * ever appears here — see `docs/observability.md` on why that is an invariant
 * rather than a default.
 */
export interface DecisionSeriesKey {
  policyKey: string;
  ruleId: string;
  decision: DecisionOutcome;
  /** `rule` when a rule decided, `default` when nothing matched. */
  reason: string;
  /**
   * The bundle in force when the decision was made.
   *
   * Carrying it turns "did this publish change anything?" from a comparison
   * between two time ranges into a comparison between two versions, which is
   * exact even while instances are still migrating.
   */
  bundleVersion: number | undefined;
}

export interface DecisionCounter extends DecisionSeriesKey {
  count: number;
}

export interface ObserverErrorContext {
  /** Where the failure happened, for callers that route by stage. */
  stage: 'record' | 'rollup' | 'transport' | 'health';
}

export type ObserverErrorHandler = (error: unknown, context: ObserverErrorContext) => void;

export interface DecisionsConfig {
  /**
   * Seconds per rollup bucket. Buckets are aligned to wall-clock so that
   * separate instances of the same service produce buckets that sum.
   *
   * The default is 300s rather than 60s: at 60s a modest policy estate exhausts
   * the default project storage quota on its own. See the volume section of the
   * observability spec.
   */
  rollupSeconds?: number;
  /**
   * Tag decision counters with the instance that produced them.
   *
   * Off by default, and that default is the important part. Health metrics are
   * inherently per-instance — each process has its own memory — but decision
   * counts are usually wanted as a fleet total, and adding the instance tag
   * multiplies the number of stored series by the size of the fleet. Instance
   * count, not metric count, is the dominant term in observability storage
   * cost.
   *
   * Turn it on to answer "is one replica denying more than its peers?", and
   * expect the quota cost to scale with replicas when you do.
   */
  perInstance?: boolean;
  /**
   * Hard ceiling on distinct series held in memory.
   *
   * On overflow, further series fold into a single `__overflow__` bucket and one
   * warning is raised. The module must never grow without bound, and must never
   * imply the data is complete when it is not.
   */
  maxSeries?: number;
}

export interface ObserverConfig {
  decisions?: DecisionsConfig | undefined;
  /** Called for every internal failure. Nothing is ever thrown at the caller. */
  onError?: ObserverErrorHandler | undefined;
}

/**
 * The observer handle.
 *
 * Reachable as `client.observe` when a remote client is configured with
 * `observe`.
 */
export interface Observer {
  /** Records a decision. Called on every evaluation; must stay allocation-light. */
  record(decision: Decision, bundleVersion: number | undefined): void;
  /** Closes the current bucket and returns its counters, emptying the buffer. */
  drain(now?: number): DecisionCounter[];
  /** Series currently held, for tests and diagnostics. */
  size(): number;
  /** Whether the cardinality ceiling has been hit since the last drain. */
  overflowed(): boolean;
}
