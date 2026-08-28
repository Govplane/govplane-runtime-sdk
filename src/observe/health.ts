/**
 * Process resource and runtime health sampling.
 *
 * Enabled with `ingestPerformanceMetrics: true` and nothing else. Reading a container
 * memory limit, diffing a cumulative CPU counter and measuring event-loop lag
 * are the same work in every application, so they belong here rather than in
 * everyone's codebase.
 *
 * Two kinds of signal, in scope for different reasons:
 *
 *   Resource pressure  — not because we want to be a resource monitor, but
 *                        because it is the highest-value trigger for an
 *                        automated policy change. Coarse resolution, short
 *                        retention, low cardinality: enough to fire a
 *                        threshold, not enough to investigate one. An APM is
 *                        where you go to find out *why* memory climbed.
 *   Runtime health     — which bundle version an instance is actually
 *                        enforcing, and how stale it is. No APM has this.
 *
 * The metric names are a cross-SDK contract, not an implementation detail. A
 * Standing Orders clause compiles to a rule naming a specific metric; if the
 * Node and Python SDKs disagree on a name, the compiled rule fires on one
 * service and silently never fires on the other.
 */

import { readFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import type { DataPoint } from './transport.js';
import type { ObserverErrorHandler } from './types.js';

/** Cross-SDK metric names. Changing one is a breaking change for alert rules. */
export const HEALTH_METRICS = {
  rss: 'gp.runtime.memory.rss_bytes',
  limitRatio: 'gp.runtime.memory.limit_ratio',
  heapRatio: 'gp.runtime.memory.heap_used_ratio',
  cpu: 'gp.runtime.cpu.percent',
  lag: 'gp.runtime.saturation.lag_ms',
  bundleAge: 'gp.runtime.bundle.age_seconds',
  uptime: 'gp.runtime.uptime_seconds',
} as const;

const DEFAULT_INTERVAL_SECONDS = 60;

/** Cores, for turning CPU time into a percentage of available capacity. */
const availableCores = (): number => {
  const list = (process as { availableParallelism?: () => number }).availableParallelism;
  if (typeof list === 'function') return list();
  return 1;
};

export interface HealthConfig {
  intervalSeconds?: number | undefined;
  source: string;
  instanceId?: string | undefined;
  /** Reads the client's current bundle state. */
  getBundleState: () => { bundleVersion: number | undefined; loadedAt: string } | undefined;
  onError?: ObserverErrorHandler | undefined;
  /** Injected in tests. */
  now?: (() => number) | undefined;
}

export interface HealthMonitor {
  /** Builds one sample. Returns [] when nothing can be measured yet. */
  sample(): DataPoint[];
  start(onSample: (points: DataPoint[]) => void): void;
  stop(): void;
}

const unref = (timer: unknown): void => {
  const t = timer as { unref?: () => void };
  if (typeof t?.unref === 'function') t.unref();
};

/**
 * The container memory limit, or undefined outside a limited cgroup.
 *
 * `os.totalmem()` is deliberately not used: in a container it reports the
 * *host's* memory, which would make `limit_ratio` meaningless in exactly the
 * deployment where the metric matters most. Where the real limit cannot be
 * determined the metric is omitted rather than computed against a wrong
 * denominator — a missing series is obvious, a confidently wrong one is not.
 */
export const readContainerMemoryLimit = async (): Promise<number | undefined> => {
  const candidates = [
    '/sys/fs/cgroup/memory.max', // cgroup v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes', // cgroup v1
  ];

  for (const path of candidates) {
    try {
      const raw = (await readFile(path, 'utf8')).trim();
      if (raw === 'max') return undefined; // v2's "no limit"
      const value = Number(raw);
      // v1 reports a sentinel near 2^63 when unlimited.
      if (Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER) {
        return value;
      }
    } catch {
      // Not Linux, or no cgroup mounted. Try the next, then give up quietly.
    }
  }
  return undefined;
};

export const createHealthMonitor = (config: HealthConfig): HealthMonitor => {
  const intervalSeconds = Math.max(10, config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
  const now = config.now ?? Date.now;

  // Sampled in native code, so p99 reflects the real distribution rather than
  // whenever a setTimeout callback happened to be scheduled.
  let lagHistogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  try {
    lagHistogram = monitorEventLoopDelay({ resolution: 20 });
    lagHistogram.enable();
  } catch (error) {
    config.onError?.(error, { stage: 'health' });
  }

  let memoryLimit: number | undefined;
  // Read once, off the sampling path: it is a filesystem call and the limit
  // does not change while the process runs.
  void readContainerMemoryLimit().then((limit) => { memoryLimit = limit; }).catch(() => {});

  let lastCpu: NodeJS.CpuUsage | undefined;
  let lastCpuAt: number | undefined;

  const baseTags = (): Record<string, string> => (
    config.instanceId ? { instanceId: config.instanceId } : {}
  );

  const point = (name: string, value: number, unit: string, timestamp: string): DataPoint => ({
    source: config.source,
    category: 'resource_consumption',
    name,
    value,
    unit,
    tags: baseTags(),
    timestamp,
  });

  const sample = (): DataPoint[] => {
    try {
      const at = now();
      const timestamp = new Date(at).toISOString();
      const points: DataPoint[] = [];

      const memory = process.memoryUsage();
      points.push(point(HEALTH_METRICS.rss, memory.rss, 'bytes', timestamp));

      if (memoryLimit !== undefined && memoryLimit > 0) {
        points.push(point(
          HEALTH_METRICS.limitRatio,
          memory.rss / memoryLimit,
          'ratio',
          timestamp,
        ));
      }

      const heapLimit = getHeapStatistics().heap_size_limit;
      if (heapLimit > 0) {
        points.push(point(
          HEALTH_METRICS.heapRatio,
          memory.heapUsed / heapLimit,
          'ratio',
          timestamp,
        ));
      }

      // Cumulative since process start, so it is only meaningful as a delta.
      // The first sample has nothing to diff against and is skipped rather than
      // reported as zero — and never as NaN, which gp-data rejects and which
      // would take the whole all-or-nothing batch down with it.
      const cpu = process.cpuUsage();
      if (lastCpu !== undefined && lastCpuAt !== undefined) {
        const elapsedMs = at - lastCpuAt;
        if (elapsedMs > 0) {
          const usedMicros = (cpu.user - lastCpu.user) + (cpu.system - lastCpu.system);
          const cores = Math.max(1, availableCores());
          const percent = (usedMicros / 1000 / elapsedMs) * (100 / cores);
          if (Number.isFinite(percent)) {
            points.push(point(HEALTH_METRICS.cpu, percent, 'percent', timestamp));
          }
        }
      }
      lastCpu = cpu;
      lastCpuAt = at;

      if (lagHistogram) {
        const p99Ns = lagHistogram.percentile(99);
        if (Number.isFinite(p99Ns)) {
          points.push(point(HEALTH_METRICS.lag, p99Ns / 1e6, 'ms', timestamp));
        }
        lagHistogram.reset();
      }

      points.push(point(HEALTH_METRICS.uptime, process.uptime(), 'seconds', timestamp));

      const bundle = config.getBundleState();
      if (bundle) {
        const loadedAt = Date.parse(bundle.loadedAt);
        if (Number.isFinite(loadedAt)) {
          points.push(point(
            HEALTH_METRICS.bundleAge,
            Math.max(0, (at - loadedAt) / 1000),
            'seconds',
            timestamp,
          ));
        }
      }

      return points;
    } catch (error) {
      config.onError?.(error, { stage: 'health' });
      return [];
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    sample,
    start(onSample) {
      if (timer) return;
      timer = setInterval(() => {
        const points = sample();
        if (points.length > 0) onSample(points);
      }, intervalSeconds * 1000);
      // A telemetry interval that keeps the event loop alive stops a CLI or a
      // job from ever exiting, and no test short of one that waits for real
      // process exit will notice.
      unref(timer);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      // Holds a libuv handle; leaving it enabled would keep the loop referenced.
      lagHistogram?.disable();
    },
  };
};

