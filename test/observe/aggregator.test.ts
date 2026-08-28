import type { Decision } from '../../src/engine/types.js';
import {
  createDecisionAggregator, bucketStart, resolveRollupSeconds, OVERFLOW_KEY,
} from '../../src/observe/aggregator.js';

const allow = (policyKey = 'p1', ruleId = 'r1'): Decision => ({
  decision: 'allow', reason: 'rule', policyKey, ruleId,
});
const deny = (policyKey = 'p1', ruleId = 'r1'): Decision => ({
  decision: 'deny', reason: 'rule', policyKey, ruleId,
});

describe('decision aggregator', () => {
  it('counts every decision, not a sample', () => {
    // The whole reason this sits on the evaluation path rather than on the
    // trace sink: traces are sampled at 1% and budget-capped, so a count taken
    // from them would be wrong by orders of magnitude and look fine.
    const agg = createDecisionAggregator();
    for (let i = 0; i < 10_000; i += 1) agg.record(allow(), 3);

    const [counter] = agg.drain();
    expect(counter?.count).toBe(10_000);
  });

  it('separates series by outcome', () => {
    const agg = createDecisionAggregator();
    agg.record(allow(), 1);
    agg.record(allow(), 1);
    agg.record(deny(), 1);

    const byDecision = Object.fromEntries(agg.drain().map((c) => [c.decision, c.count]));
    expect(byDecision).toEqual({ allow: 2, deny: 1 });
  });

  it('separates series by bundle version', () => {
    // This is what makes a publish watch an exact comparison between two
    // versions rather than a guess about when instances finished migrating.
    const agg = createDecisionAggregator();
    agg.record(allow(), 4);
    agg.record(allow(), 5);

    const versions = agg.drain().map((c) => c.bundleVersion).sort();
    expect(versions).toEqual([4, 5]);
  });

  it('keeps a decision with no matching rule distinguishable', () => {
    const agg = createDecisionAggregator();
    agg.record({ decision: 'deny', reason: 'default' }, 1);

    const [counter] = agg.drain();
    expect(counter).toMatchObject({ reason: 'default', count: 1 });
  });

  it('cannot have one series forged into another by a crafted key', () => {
    // A printable separator would let a policy key containing it collide with a
    // different series.
    const agg = createDecisionAggregator();
    agg.record(allow('a:b', 'c'), 1);
    agg.record(allow('a', 'b:c'), 1);
    expect(agg.size()).toBe(2);
  });

  it('empties on drain so a bucket is never double-counted', () => {
    const agg = createDecisionAggregator();
    agg.record(allow(), 1);
    expect(agg.drain()).toHaveLength(1);
    expect(agg.drain()).toHaveLength(0);
  });
});

describe('cardinality ceiling', () => {
  it('stops growing and folds the excess', () => {
    const agg = createDecisionAggregator({ maxSeries: 10 });
    for (let i = 0; i < 500; i += 1) agg.record(allow(`p${i}`), 1);

    expect(agg.size()).toBeLessThanOrEqual(11); // 10 + the overflow bucket
    expect(agg.overflowed()).toBe(true);
  });

  it('keeps the total honest even when the breakdown is not', () => {
    // Dropping would understate the decision rate, which is the one number the
    // alerting is built on. Folding keeps the sum right and says so.
    const agg = createDecisionAggregator({ maxSeries: 10 });
    for (let i = 0; i < 500; i += 1) agg.record(allow(`p${i}`), 1);

    const total = agg.drain().reduce((sum, c) => sum + c.count, 0);
    expect(total).toBe(500);
  });

  it('names the overflow bucket rather than hiding it', () => {
    const agg = createDecisionAggregator({ maxSeries: 2 });
    for (let i = 0; i < 20; i += 1) agg.record(allow(`p${i}`), 1);

    expect(agg.drain().some((c) => c.policyKey === OVERFLOW_KEY)).toBe(true);
  });
});

describe('never throws into the caller', () => {
  it('swallows a malformed decision and reports it', () => {
    // record() runs inside evaluate(). Anything escaping here would take down
    // the host application's authorization path.
    const errors: unknown[] = [];
    const agg = createDecisionAggregator({}, (e) => errors.push(e));

    const hostile = {
      get decision() { throw new Error('boom'); },
      reason: 'rule',
    } as unknown as Decision;

    expect(() => agg.record(hostile, 1)).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

describe('bucket alignment', () => {
  it('aligns to wall clock so replicas produce summable buckets', () => {
    // Unaligned, twenty replicas land on twenty boundaries and cannot be summed
    // into a fleet rate without smearing across intervals.
    const a = bucketStart(1_700_000_123_456, 300);
    const b = bucketStart(1_700_000_200_000, 300);
    expect(a).toBe(b);
    expect(a % 300_000).toBe(0);
  });

  it('defaults to 300s, not 60s', () => {
    // 60s exhausts the default project storage quota on a modest estate.
    expect(resolveRollupSeconds()).toBe(300);
  });

  it('refuses a rollup finer than 10s', () => {
    expect(resolveRollupSeconds({ rollupSeconds: 1 })).toBe(10);
  });
});
