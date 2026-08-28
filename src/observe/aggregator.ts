/**
 * In-process rollup of policy decisions.
 *
 * **Why this exists rather than a trace sink.** The obvious seam looks like
 * `onDecisionTrace`, but it cannot answer "how many decisions did this rule
 * make". Two reasons, both silent if missed:
 *
 *   - `evaluate()` never emits a trace at all. Only `evaluateWithTrace()` does,
 *     and most applications call the former.
 *   - Even `evaluateWithTrace()` samples: the default level is `sampled` at 1%,
 *     under a 60-per-minute budget.
 *
 * Telemetry built on that stream would under-count by orders of magnitude while
 * looking perfectly healthy. So decisions are counted here, on the evaluation
 * path, unsampled - and the trace stream keeps its proper job of carrying a
 * small number of full exemplars.
 *
 * The cost per evaluation is one string build and one map increment. Nothing
 * here allocates per-decision beyond that, and nothing here can throw into the
 * caller: `record` is invoked from inside `evaluate`.
 */

import type { Decision } from '../engine/types.js';
import type {
  DecisionCounter, DecisionsConfig, Observer, ObserverErrorHandler,
} from './types.js';

const DEFAULT_ROLLUP_SECONDS = 300;
const DEFAULT_MAX_SERIES = 1000;

/**
 * Stands in for every series past the ceiling.
 *
 * Folding rather than dropping keeps the totals honest: the count is still
 * right even when the breakdown is not, and `overflowed()` says so.
 */
const OVERFLOW_KEY = '__overflow__';

/** Used when a decision carries no policy or rule - a `default` outcome. */
const NONE = '-';

/**
 * Field separator: ASCII unit separator, not a printable character, so a policy
 * key containing the delimiter cannot forge a different series.
 */
const SEP = String.fromCharCode(31);

interface Bucket {
  policyKey: string;
  ruleId: string;
  decision: string;
  reason: string;
  bundleVersion: number | undefined;
  count: number;
}

export const createDecisionAggregator = (
  config: DecisionsConfig = {},
  onError?: ObserverErrorHandler,
): Observer => {
  const maxSeries = config.maxSeries ?? DEFAULT_MAX_SERIES;
  const buckets = new Map<string, Bucket>();
  let overflow = false;

  const record = (decision: Decision, bundleVersion: number | undefined): void => {
    try {
      const policyKey = decision.policyKey ?? NONE;
      const ruleId = decision.ruleId ?? NONE;
      const key = `${policyKey}${SEP}${ruleId}${SEP}${decision.decision}`
        + `${SEP}${decision.reason}${SEP}${bundleVersion ?? NONE}`;

      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }

      if (buckets.size >= maxSeries) {
        overflow = true;
        const folded = buckets.get(OVERFLOW_KEY);
        if (folded) {
          folded.count += 1;
          return;
        }
        buckets.set(OVERFLOW_KEY, {
          policyKey: OVERFLOW_KEY,
          ruleId: OVERFLOW_KEY,
          decision: decision.decision,
          reason: 'overflow',
          bundleVersion,
          count: 1,
        });
        return;
      }

      buckets.set(key, {
        policyKey,
        ruleId,
        decision: decision.decision,
        reason: decision.reason,
        bundleVersion,
        count: 1,
      });
    } catch (error) {
      // Never propagates: this runs inside the caller's evaluate().
      onError?.(error, { stage: 'record' });
    }
  };

  const drain = (): DecisionCounter[] => {
    const out: DecisionCounter[] = [];
    buckets.forEach((b) => {
      out.push({
        policyKey: b.policyKey,
        ruleId: b.ruleId,
        decision: b.decision as DecisionCounter['decision'],
        reason: b.reason,
        bundleVersion: b.bundleVersion,
        count: b.count,
      });
    });
    buckets.clear();
    overflow = false;
    return out;
  };

  return {
    record,
    drain,
    size: () => buckets.size,
    overflowed: () => overflow,
  };
};

/**
 * Start of the wall-clock-aligned bucket containing `nowMs`.
 *
 * Alignment matters across instances: unaligned buckets from twenty replicas
 * land on twenty different boundaries and cannot be summed into a fleet rate
 * without smearing across adjacent intervals.
 */
export const bucketStart = (nowMs: number, rollupSeconds: number): number => {
  const width = rollupSeconds * 1000;
  return Math.floor(nowMs / width) * width;
};

export const resolveRollupSeconds = (config: DecisionsConfig = {}): number => {
  const requested = config.rollupSeconds ?? DEFAULT_ROLLUP_SECONDS;
  // A sub-10s rollup produces more data points than the decisions they
  // summarise are worth, and quota is the binding constraint here.
  return Math.max(10, Math.floor(requested));
};

export { DEFAULT_ROLLUP_SECONDS, DEFAULT_MAX_SERIES, OVERFLOW_KEY };
