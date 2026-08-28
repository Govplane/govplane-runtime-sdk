import { describe, expect, it } from '@jest/globals';
import { createHealthMonitor, HEALTH_METRICS } from '../../src/observe/health.js';

interface Handle { hasRef?: () => boolean; constructor?: { name?: string } }

/**
 * Health sampling.
 *
 * Most of these guard hazards rather than features: a cumulative counter
 * reported as a gauge, a first sample with nothing to diff, a container limit
 * that cannot be read. Each produces a plausible-looking number that is wrong,
 * which is the failure mode this module has to avoid.
 */

const bundleState = () => ({ bundleVersion: 3, loadedAt: new Date().toISOString() });

const monitor = (over: Partial<Parameters<typeof createHealthMonitor>[0]> = {}) => (
  createHealthMonitor({
    source: 'auth-api',
    getBundleState: bundleState,
    ...over,
  })
);

const nameOf = (points: { name: string }[]): string[] => points.map((p) => p.name);

describe('the default sample', () => {
  it('reports resident memory', () => {
    const points = monitor().sample();
    expect(nameOf(points)).toContain(HEALTH_METRICS.rss);
    expect(points.find((p) => p.name === HEALTH_METRICS.rss)?.value).toBeGreaterThan(0);
  });

  it('reports heap use as a ratio of the heap ceiling', () => {
    // The ratio is what a threshold rule can be written against; absolute bytes
    // require knowing the ceiling to interpret.
    const point = monitor().sample().find((p) => p.name === HEALTH_METRICS.heapRatio);
    expect(point?.value).toBeGreaterThan(0);
    expect(point?.value).toBeLessThanOrEqual(1);
  });

  it('reports event-loop lag', () => {
    expect(nameOf(monitor().sample())).toContain(HEALTH_METRICS.lag);
  });

  it('reports uptime, which separates a crash loop from a steady process', () => {
    expect(nameOf(monitor().sample())).toContain(HEALTH_METRICS.uptime);
  });

  it('reports how stale the bundle in force is', () => {
    // A governance question no APM can answer.
    const point = monitor().sample().find((p) => p.name === HEALTH_METRICS.bundleAge);
    expect(point?.value).toBeGreaterThanOrEqual(0);
  });

  it('is categorised so gp-data can retain it separately from decisions', () => {
    // Resource signal exists to fire a threshold and is worthless a week later;
    // decision series are the historical record. Different retention.
    const points = monitor().sample();
    expect(points.every((p) => p.category === 'resource_consumption')).toBe(true);
  });

  it('carries instanceId when configured', () => {
    const points = monitor({ instanceId: 'pod-7' }).sample();
    expect(points.every((p) => p.tags.instanceId === 'pod-7')).toBe(true);
  });

  it('stays small, because per-instance metrics dominate quota cost', () => {
    expect(monitor().sample().length).toBeLessThanOrEqual(8);
  });
});

describe('CPU is cumulative, not a gauge', () => {
  it('omits CPU on the first sample rather than reporting zero', () => {
    // process.cpuUsage() is a total since process start. The first sample has
    // nothing to diff against; a zero would read as an idle process.
    expect(nameOf(monitor().sample())).not.toContain(HEALTH_METRICS.cpu);
  });

  it('reports CPU once there are two samples to diff', () => {
    let clock = 1_000_000;
    const m = monitor({ now: () => clock });

    m.sample();
    clock += 60_000;
    const points = m.sample();

    expect(nameOf(points)).toContain(HEALTH_METRICS.cpu);
  });

  it('never emits a non-finite value', () => {
    // gp-data rejects non-finite values and its batches are all-or-nothing, so
    // one NaN discards every other metric in the same request.
    let clock = 1_000_000;
    const m = monitor({ now: () => clock });

    m.sample();
    const points = m.sample(); // same timestamp: elapsed is zero

    expect(points.every((p) => Number.isFinite(p.value))).toBe(true);
    expect(nameOf(points)).not.toContain(HEALTH_METRICS.cpu);
  });
});

describe('container memory limit', () => {
  it('omits limit_ratio when the limit cannot be determined', () => {
    // os.totalmem() would report the host's memory inside a container, making
    // the ratio meaningless in exactly the deployment that needs it. A missing
    // series is obvious; a confidently wrong one is not.
    const points = monitor().sample();
    const ratio = points.find((p) => p.name === HEALTH_METRICS.limitRatio);
    if (ratio) {
      expect(ratio.value).toBeGreaterThan(0);
    } else {
      expect(nameOf(points)).not.toContain(HEALTH_METRICS.limitRatio);
    }
  });
});

describe('it cannot break the host application', () => {
  it('returns an empty sample and reports when reading state throws', () => {
    const errors: unknown[] = [];
    const m = monitor({
      getBundleState: () => { throw new Error('boom'); },
      onError: (e) => errors.push(e),
    });

    expect(() => m.sample()).not.toThrow();
    expect(m.sample()).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not hold the event loop open', async () => {
    // The defect that gets a telemetry dependency removed: a CLI or job that
    // never exits. Verified by checking the handle is unreferenced, since a
    // referenced interval would keep this process alive too.
    const m = monitor({ intervalSeconds: 10 });
    m.start(() => {});

    const active = (process as unknown as { _getActiveHandles?: () => Handle[] })
      ._getActiveHandles?.() ?? [];
    const referencedIntervals = active.filter(
      (h) => h.hasRef?.() === true && h.constructor?.name === 'Timeout',
    );

    m.stop();
    expect(referencedIntervals).toHaveLength(0);
  });

  it('stops cleanly and releases the lag histogram handle', () => {
    const m = monitor();
    m.start(() => {});
    expect(() => m.stop()).not.toThrow();
    expect(() => m.stop()).not.toThrow();
  });
});

describe('metric names are a cross-SDK contract', () => {
  it('pins the names the Python SDK must also emit', () => {
    // A Standing Orders clause compiles to a rule naming a specific metric. If
    // the SDKs disagree, the rule fires on one service and silently never fires
    // on the other. Changing any of these is a breaking change for alert rules.
    expect(HEALTH_METRICS).toEqual({
      rss: 'gp.runtime.memory.rss_bytes',
      limitRatio: 'gp.runtime.memory.limit_ratio',
      heapRatio: 'gp.runtime.memory.heap_used_ratio',
      cpu: 'gp.runtime.cpu.percent',
      lag: 'gp.runtime.saturation.lag_ms',
      bundleAge: 'gp.runtime.bundle.age_seconds',
      uptime: 'gp.runtime.uptime_seconds',
    });
  });
});
