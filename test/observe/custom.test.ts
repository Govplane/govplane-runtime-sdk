import { describe, expect, it } from '@jest/globals';
import { CustomAggregator, CUSTOM_LIMITS } from '../../src/observe/custom.js';

/**
 * Custom application metrics.
 *
 * Most of these guard the batch rather than the feature. gp-data validates a
 * request all-or-nothing, so a single malformed custom point would discard
 * every decision counter travelling with it. Rejecting client-side is what
 * keeps one caller's mistake from erasing everyone else's telemetry.
 */

const drain = (agg: CustomAggregator) => agg.drain(0, 'checkout-api');

describe('counting things that happen', () => {
  it('sums repeated events into one point', () => {
    const agg = new CustomAggregator();
    for (let i = 0; i < 12; i += 1) agg.event('payment.failed');

    const [point] = drain(agg);
    expect(point).toMatchObject({ name: 'payment.failed', value: 12, unit: 'count' });
  });

  it('accepts an explicit increment', () => {
    const agg = new CustomAggregator();
    agg.event('items.sold', { value: 3 });
    agg.event('items.sold', { value: 4 });

    expect(drain(agg)[0]?.value).toBe(7);
  });

  it('separates series by tag', () => {
    const agg = new CustomAggregator();
    agg.event('payment.failed', { tags: { provider: 'stripe' } });
    agg.event('payment.failed', { tags: { provider: 'adyen' } });

    expect(drain(agg)).toHaveLength(2);
  });

  it('treats tag order as irrelevant', () => {
    const agg = new CustomAggregator();
    agg.event('e', { tags: { a: '1', b: '2' } });
    agg.event('e', { tags: { b: '2', a: '1' } });

    expect(drain(agg)).toHaveLength(1);
  });

  it('carries the category through, so alert rules can scope to it', () => {
    const agg = new CustomAggregator();
    agg.event('payment.failed', { category: 'error_rate' });

    expect(drain(agg)[0]?.category).toBe('error_rate');
  });

  it('defaults to the custom category', () => {
    const agg = new CustomAggregator();
    agg.event('anything');
    expect(drain(agg)[0]?.category).toBe('custom');
  });
});

describe('measuring a level', () => {
  it('keeps the last value in the interval by default', () => {
    const agg = new CustomAggregator();
    agg.metric('queue_depth', 10);
    agg.metric('queue_depth', 40);

    expect(drain(agg)[0]?.value).toBe(40);
  });

  it('reduces by max when asked', () => {
    const agg = new CustomAggregator();
    agg.metric('queue_depth', 40, { aggregation: 'max' });
    agg.metric('queue_depth', 10, { aggregation: 'max' });

    expect(drain(agg)[0]?.value).toBe(40);
  });

  it('averages across the interval when asked', () => {
    const agg = new CustomAggregator();
    agg.metric('cart_value', 10, { aggregation: 'avg' });
    agg.metric('cart_value', 20, { aggregation: 'avg' });
    agg.metric('cart_value', 60, { aggregation: 'avg' });

    expect(drain(agg)[0]?.value).toBe(30);
  });

  it('carries a unit', () => {
    const agg = new CustomAggregator();
    agg.metric('latency', 12, { unit: 'ms' });
    expect(drain(agg)[0]?.unit).toBe('ms');
  });
});

describe('nothing malformed reaches the batch', () => {
  const rejected = (act: (agg: CustomAggregator) => void) => {
    const errors: unknown[] = [];
    const agg = new CustomAggregator((e) => errors.push(e));
    act(agg);
    return { points: drain(agg), errors };
  };

  it('drops a non-finite value rather than sending NaN', () => {
    // gp-data rejects non-finite values and its batch is all-or-nothing, so one
    // NaN would discard every decision counter in the same request.
    const { points, errors } = rejected((agg) => agg.metric('broken', Number.NaN));
    expect(points).toHaveLength(0);
    expect(String(errors[0])).toMatch(/finite/i);
  });

  it('drops a metric with too many tags', () => {
    const tags = Object.fromEntries(
      Array.from({ length: CUSTOM_LIMITS.maxTagCount + 1 }, (_, i) => [`t${i}`, 'v']),
    );
    const { points, errors } = rejected((agg) => agg.event('e', { tags }));
    expect(points).toHaveLength(0);
    expect(String(errors[0])).toMatch(/low-cardinality/i);
  });

  it('drops an oversized tag value, and says why', () => {
    // A value that long is nearly always request data, which must not be sent
    // as a tag — a privacy problem as much as a cardinality one.
    const { points, errors } = rejected((agg) => agg.event('e', {
      tags: { blob: 'x'.repeat(CUSTOM_LIMITS.maxTagValueLength + 1) },
    }));
    expect(points).toHaveLength(0);
    expect(String(errors[0])).toMatch(/request data/i);
  });

  it('drops an empty name', () => {
    const { points } = rejected((agg) => agg.event('  '));
    expect(points).toHaveLength(0);
  });

  it('never throws at the caller', () => {
    const agg = new CustomAggregator();
    expect(() => agg.event(undefined as unknown as string)).not.toThrow();
    expect(() => agg.metric('x', 'not a number' as unknown as number)).not.toThrow();
  });
});

describe('cardinality ceiling', () => {
  it('refuses new series past the limit rather than growing', () => {
    const agg = new CustomAggregator();
    for (let i = 0; i < CUSTOM_LIMITS.maxSeries + 50; i += 1) {
      agg.event('e', { tags: { id: String(i) } });
    }

    expect(agg.size()).toBe(CUSTOM_LIMITS.maxSeries);
    expect(agg.droppedCount()).toBe(50);
  });

  it('names the likely cause, since it is usually a tag mistake', () => {
    const errors: unknown[] = [];
    const agg = new CustomAggregator((e) => errors.push(e));
    for (let i = 0; i < CUSTOM_LIMITS.maxSeries + 1; i += 1) {
      agg.event('e', { tags: { userId: String(i) } });
    }

    expect(String(errors.at(-1))).toMatch(/high-cardinality tag/i);
  });

  it('refuses rather than folding, unlike decision series', () => {
    // Decision series names come from the bundle and are bounded by it, so
    // folding keeps the total honest. Custom names come from the application,
    // so an unbounded set is a caller bug that folding would hide.
    const agg = new CustomAggregator();
    for (let i = 0; i < CUSTOM_LIMITS.maxSeries + 10; i += 1) {
      agg.event(`series_${i}`);
    }

    expect(drain(agg).some((p) => p.name.includes('overflow'))).toBe(false);
  });
});

describe('draining', () => {
  it('empties so an interval is never double-counted', () => {
    const agg = new CustomAggregator();
    agg.event('e');
    expect(drain(agg)).toHaveLength(1);
    expect(drain(agg)).toHaveLength(0);
  });

  it('stamps every point with the bucket start', () => {
    const agg = new CustomAggregator();
    agg.event('e');
    expect(agg.drain(Date.UTC(2026, 0, 1), 'svc')[0]?.timestamp)
      .toBe('2026-01-01T00:00:00.000Z');
  });
});
