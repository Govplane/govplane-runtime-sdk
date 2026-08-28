/**
 * Custom application metrics.
 *
 * Decision telemetry says what your policies decided. This says whether they
 * were right. "Rule X denied 12% of checkouts" is a curiosity on its own;
 * "…and payment failures tripled" is a reason to act, and it is the signal an
 * automated rule can be trusted with.
 *
 * Two shapes, because counting a thing and measuring a thing aggregate
 * differently:
 *
 *   event('payment.failed')          how many times it happened  -> summed
 *   metric('queue_depth', 128)       what the level was          -> reduced
 *
 * Both are aggregated in-process for the same reason decisions are: one call
 * per request shipped individually would exhaust a project's storage quota in
 * minutes. The SDK reduces within a bucket; gp-data's alert rules reduce across
 * buckets.
 */

import type { DataPoint } from './transport.js';
import type { ObserverErrorHandler } from './types.js';

/**
 * Categories gp-data accepts. Choosing one scopes the alert rules that can
 * match the series, so `error_rate` for a failure count is worth the keystroke
 * over the `custom` default.
 */
export type CustomCategory =
  | 'custom'
  | 'error_rate'
  | 'http_error_rate'
  | 'request_latency'
  | 'resource_consumption'
  | 'security'
  | 'cost';

/** How repeated measurements in one bucket reduce to a single point. */
export type MetricAggregation = 'last' | 'avg' | 'min' | 'max' | 'sum';

export interface EventOptions {
  /** Increment by more than one. */
  value?: number | undefined;
  tags?: Record<string, string | number | boolean> | undefined;
  category?: CustomCategory | undefined;
}

export interface MetricOptions {
  tags?: Record<string, string | number | boolean> | undefined;
  category?: CustomCategory | undefined;
  unit?: string | undefined;
  /** Defaults to `last`. */
  aggregation?: MetricAggregation | undefined;
}

/**
 * Client-side limits, deliberately tighter than gp-data's.
 *
 * gp-data validates a batch **all-or-nothing**: one point with 21 tags rejects
 * every other point in the same request, including decision counters that have
 * nothing to do with it. So a bad custom metric is dropped here, with a report,
 * rather than sent and allowed to poison the flush. The headroom below the
 * server's own limits is what keeps that true even if the two drift.
 */
export const CUSTOM_LIMITS = {
  maxNameLength: 200,
  maxTagCount: 10,
  maxTagKeyLength: 60,
  maxTagValueLength: 200,
  /** Distinct custom series held before new ones are refused. */
  maxSeries: 500,
} as const;

interface Bucket {
  name: string;
  category: CustomCategory;
  unit: string;
  tags: Record<string, string>;
  aggregation: MetricAggregation | 'count';
  value: number;
  /** Only used by `avg`. */
  samples: number;
}

const SEP = String.fromCharCode(31);

const reduce = (bucket: Bucket, next: number): number => {
  switch (bucket.aggregation) {
    case 'count':
    case 'sum':
    case 'avg':
      return bucket.value + next;
    case 'min':
      return Math.min(bucket.value, next);
    case 'max':
      return Math.max(bucket.value, next);
    case 'last':
    default:
      return next;
  }
};

/** Order-stable, so `{a,b}` and `{b,a}` are the same series. */
const stableTags = (tags: Record<string, string>): string => Object.keys(tags)
  .sort()
  .map((key) => `${key}=${tags[key]}`)
  .join(SEP);

export class CustomAggregator {
  private readonly buckets = new Map<string, Bucket>();

  private dropped = 0;

  constructor(private readonly onError?: ObserverErrorHandler | undefined) {}

  event(name: string, options: EventOptions = {}): void {
    const increment = options.value ?? 1;
    this.upsert(name, increment, {
      category: options.category ?? 'custom',
      unit: 'count',
      tags: options.tags,
      aggregation: 'count',
    });
  }

  metric(name: string, value: number, options: MetricOptions = {}): void {
    this.upsert(name, value, {
      category: options.category ?? 'custom',
      unit: options.unit ?? 'none',
      tags: options.tags,
      aggregation: options.aggregation ?? 'last',
    });
  }

  private upsert(
    name: string,
    value: number,
    spec: {
      category: CustomCategory;
      unit: string;
      tags: Record<string, string | number | boolean> | undefined;
      aggregation: MetricAggregation | 'count';
    },
  ): void {
    try {
      if (typeof name !== 'string' || name.trim() === '') {
        this.reject('a metric name must be a non-empty string');
        return;
      }
      if (name.length > CUSTOM_LIMITS.maxNameLength) {
        this.reject(`metric name '${name.slice(0, 40)}…' exceeds `
          + `${CUSTOM_LIMITS.maxNameLength} characters`);
        return;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        // gp-data rejects non-finite values, and its batch is all-or-nothing.
        this.reject(`value for '${name}' must be a finite number`);
        return;
      }

      const tags = this.normaliseTags(name, spec.tags);
      if (tags === null) return;

      const key = `${name}${SEP}${spec.category}${SEP}${stableTags(tags)}`;
      const existing = this.buckets.get(key);

      if (existing) {
        existing.value = reduce(existing, value);
        existing.samples += 1;
        return;
      }

      if (this.buckets.size >= CUSTOM_LIMITS.maxSeries) {
        // Refused rather than folded: unlike decision series, these names are
        // chosen by the application, so an unbounded set is a bug in the caller
        // and folding would hide it.
        this.reject(
          `custom series limit of ${CUSTOM_LIMITS.maxSeries} reached; `
          + `'${name}' was dropped. Check for a high-cardinality tag value.`,
        );
        return;
      }

      this.buckets.set(key, {
        name,
        category: spec.category,
        unit: spec.unit,
        tags,
        aggregation: spec.aggregation,
        value,
        samples: 1,
      });
    } catch (error) {
      this.onError?.(error, { stage: 'record' });
    }
  }

  private normaliseTags(
    name: string,
    tags: Record<string, string | number | boolean> | undefined,
  ): Record<string, string> | null {
    if (tags === undefined) return {};

    const entries = Object.entries(tags);
    if (entries.length > CUSTOM_LIMITS.maxTagCount) {
      this.reject(
        `'${name}' has ${entries.length} tags; the limit is `
        + `${CUSTOM_LIMITS.maxTagCount}. Tags are for low-cardinality `
        + 'dimensions, not for request detail.',
      );
      return null;
    }

    const out: Record<string, string> = {};
    for (const [key, raw] of entries) {
      if (key.length > CUSTOM_LIMITS.maxTagKeyLength) {
        this.reject(`tag key '${key.slice(0, 30)}…' on '${name}' is too long`);
        return null;
      }
      const value = String(raw);
      if (value.length > CUSTOM_LIMITS.maxTagValueLength) {
        this.reject(
          `tag '${key}' on '${name}' exceeds ${CUSTOM_LIMITS.maxTagValueLength} `
          + 'characters. A value that long is usually request data, which must '
          + 'not be sent as a tag.',
        );
        return null;
      }
      out[key] = value;
    }
    return out;
  }

  private reject(message: string): void {
    this.dropped += 1;
    this.onError?.(new Error(`Govplane: ${message}`), { stage: 'record' });
  }

  /** Returns the bucket's points and empties it. */
  drain(bucketStartMs: number, source: string): DataPoint[] {
    const timestamp = new Date(bucketStartMs).toISOString();
    const points: DataPoint[] = [];

    this.buckets.forEach((bucket) => {
      points.push({
        source,
        category: bucket.category,
        name: bucket.name,
        value: bucket.aggregation === 'avg' ? bucket.value / bucket.samples : bucket.value,
        unit: bucket.unit,
        tags: bucket.tags,
        timestamp,
      });
    });

    this.buckets.clear();
    return points;
  }

  size(): number {
    return this.buckets.size;
  }

  droppedCount(): number {
    return this.dropped;
  }
}
