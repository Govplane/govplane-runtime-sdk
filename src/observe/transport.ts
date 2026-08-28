/**
 * Ships rolled-up counters to Govplane Cloud.
 *
 * Everything here is subordinate to one rule: the host application must not be
 * able to tell that it is running. No error escapes, no timer holds the process
 * open, no queue grows without bound, and nothing blocks a decision.
 */

import type { DecisionCounter, ObserverErrorHandler } from './types.js';

/** gp-data accepts at most this many data points per request. */
const MAX_POINTS_PER_BATCH = 500;

/** Log entries carry more per record, so gp-data caps their batch lower. */
const MAX_LOGS_PER_BATCH = 100;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

/**
 * How long to stop trying after the server says the project is out of quota.
 *
 * Retrying into a full quota cannot succeed, and doing it on every rollup turns
 * one problem into a second one. The condition is reported once and the
 * transport goes quiet until the window elapses.
 */
const QUOTA_COOLOFF_MS = 15 * 60 * 1000;

/** The metric every decision counter is reported under. */
const DECISION_METRIC = 'gp.policy.decisions';

export interface TransportConfig {
  /** e.g. `https://<tenantId>.ingest.govplane.com` */
  endpoint: string;
  runtimeKey: string;
  projectId: string;
  env: string;
  /** Identifies the emitting service in the series. */
  source: string;
  /** Stable per process; required for fleet-aware alert conditions. */
  instanceId?: string | undefined;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  onError?: ObserverErrorHandler | undefined;
}

/** One correlated occurrence, as gp-data's log ingest accepts it. */
export interface LogRecord {
  source: string;
  level: 'info' | 'warn' | 'error' | 'critical';
  message: string;
  code?: string | undefined;
  traceId?: string | undefined;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface Transport {
  send(counters: DecisionCounter[], bucketStartMs: number): Promise<void>;
  /**
   * Ships already-built points.
   *
   * Health samples are gauges rather than counters, so they arrive here already
   * shaped. Sharing the batching, retry and quota cool-off matters more than
   * the shape they arrived in: a paused transport must stay paused for every
   * kind of telemetry, not just the one that hit the limit.
   */
  sendPoints(points: DataPoint[]): Promise<void>;
  /**
   * Ships correlated occurrences to the log path.
   *
   * A separate endpoint and a separate batch ceiling, but the same cool-off:
   * a project out of quota is out of quota for every kind of telemetry.
   */
  sendLogs(records: LogRecord[]): Promise<void>;
  /** True while a quota cool-off is in force. */
  isPaused(now?: number): boolean;
}

/** Matches the shape gp-data's ingest validation accepts. */
export interface DataPoint {
  source: string;
  category:
    | 'policy_decision'
    | 'resource_consumption'
    | 'custom'
    | 'error_rate'
    | 'http_error_rate'
    | 'request_latency'
    | 'security'
    | 'cost';
  name: string;
  value: number;
  unit: string;
  tags: Record<string, string>;
  timestamp: string;
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const unref = (timer: unknown): void => {
  const t = timer as { unref?: () => void };
  if (typeof t?.unref === 'function') t.unref();
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  // Unreferenced: a pending backoff must never be the reason a process stays
  // alive. A telemetry library that delays exit gets removed as a dependency.
  unref(setTimeout(resolve, ms));
});

const backoffMs = (attempt: number): number => {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  // Jitter, so a fleet that started together does not retry together.
  return base / 2 + Math.random() * (base / 2);
};

export const toDataPoints = (
  counters: DecisionCounter[],
  bucketStartMs: number,
  config: Pick<TransportConfig, 'source' | 'instanceId'>,
): DataPoint[] => {
  const timestamp = new Date(bucketStartMs).toISOString();

  return counters.map((c) => {
    const tags: Record<string, string> = {
      policyKey: c.policyKey,
      ruleId: c.ruleId,
      decision: c.decision,
      reason: c.reason,
      // Omitted rather than sent as "undefined": a literal string would create
      // a series that looks like a real bundle version.
      ...(c.bundleVersion === undefined ? {} : { bundleVersion: String(c.bundleVersion) }),
      ...(config.instanceId ? { instanceId: config.instanceId } : {}),
    };

    return {
      source: config.source,
      category: 'policy_decision' as const,
      name: DECISION_METRIC,
      value: c.count,
      unit: 'count',
      tags,
      timestamp,
    };
  });
};

/**
 * An idempotency key for one batch.
 *
 * Deliberately not a UUID. gp-data scopes dedup keys by org and project and
 * expires them on a TTL, so uniqueness within one process over one window is
 * all that is required — and building it from a clock, a counter and a random
 * suffix avoids depending on `crypto` being global, which differs across the
 * runtimes this package supports.
 */
let keyCounter = 0;
const newKey = (): string => {
  keyCounter += 1;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `gp-${Date.now().toString(36)}-${keyCounter.toString(36)}-${suffix}`;
};

export const createTransport = (config: TransportConfig): Transport => {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const base = config.endpoint.replace(/\/+$/, '');
  const scope = `${base}/v1/${encodeURIComponent(config.projectId)}`
    + `/${encodeURIComponent(config.env)}`;
  const url = `${scope}/metrics`;
  const logsUrl = `${scope}/logs`;

  let pausedUntil = 0;
  let quotaReported = false;

  const isPaused = (now = Date.now()): boolean => now < pausedUntil;

  const postOnce = async (
    body: string,
    key: string,
    target: string,
  ): Promise<'ok' | 'retry' | 'stop'> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    unref(timer);

    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: config.runtimeKey,
          'idempotency-key': key,
        },
        // `env` is sent even though the edge pins it from the runtime key. A
        // mismatch is then a loud 403 at the first batch rather than telemetry
        // filed silently under an environment nobody is looking at.
        body,
        signal: controller.signal,
      });

      if (response.ok) return 'ok';

      if (response.status === 429) {
        pausedUntil = Date.now() + QUOTA_COOLOFF_MS;
        if (!quotaReported) {
          quotaReported = true;
          config.onError?.(
            new Error(
              'Govplane observability quota exhausted; telemetry paused for 15 minutes. '
              + 'Policy evaluation is unaffected.',
            ),
            { stage: 'transport' },
          );
        }
        return 'stop';
      }

      // A rejected credential or a malformed batch will be rejected again
      // identically; only the server's own faults are worth repeating.
      if (response.status >= 400 && response.status < 500) return 'stop';
      return 'retry';
    } finally {
      clearTimeout(timer);
    }
  };

  const sendBatch = async (body: string, target: string): Promise<void> => {
    // One key per batch, reused across attempts: that is what makes a retry
    // after a timeout a replay rather than a double count.
    const key = newKey();

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (isPaused()) return;

      let outcome: 'ok' | 'retry' | 'stop';
      try {
          outcome = await postOnce(body, key, target);
      } catch (error) {
        // Network failure or timeout.
        outcome = 'retry';
        if (attempt === maxAttempts - 1) config.onError?.(error, { stage: 'transport' });
      }

      if (outcome === 'ok' || outcome === 'stop') return;
      if (attempt < maxAttempts - 1) await sleep(backoffMs(attempt));
    }
  };

  const sendPoints = async (points: DataPoint[]): Promise<void> => {
    if (points.length === 0 || isPaused()) return;

    try {
      for (const batch of chunk(points, MAX_POINTS_PER_BATCH)) {
        await sendBatch(JSON.stringify({ env: config.env, points: batch }), url);
      }
    } catch (error) {
      // Telemetry is never worth an exception in the host application.
      config.onError?.(error, { stage: 'transport' });
    }
  };

  const send = async (counters: DecisionCounter[], bucketStartMs: number): Promise<void> => {
    if (counters.length === 0) return;
    await sendPoints(toDataPoints(counters, bucketStartMs, config));
  };

  const sendLogs = async (records: LogRecord[]): Promise<void> => {
    if (records.length === 0 || isPaused()) return;

    try {
      for (const batch of chunk(records, MAX_LOGS_PER_BATCH)) {
        await sendBatch(JSON.stringify({ env: config.env, entries: batch }), logsUrl);
      }
    } catch (error) {
      config.onError?.(error, { stage: 'transport' });
    }
  };

  return { send, sendPoints, sendLogs, isPaused };
};

export {
  MAX_POINTS_PER_BATCH, MAX_LOGS_PER_BATCH, QUOTA_COOLOFF_MS, DECISION_METRIC,
  DEFAULT_MAX_ATTEMPTS,
};
