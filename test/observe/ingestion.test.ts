import { describe, expect, it } from '@jest/globals';
import { resolveIngestion, type IngestionSwitches } from '../../src/observe/ingestion.js';

/**
 * What a customer is billed for, decided in one pure function.
 *
 * The table below is the whole contract. It is worth testing exhaustively
 * rather than sampling, because both directions of getting it wrong are
 * expensive and neither announces itself: too eager and somebody pays for
 * telemetry they never asked for, too strict and somebody's dashboards go blank
 * on an upgrade with nothing to say why.
 */

const resolve = (config: IngestionSwitches) => resolveIngestion(config);

describe('the master switch', () => {
  it('sends nothing when it is off', () => {
    // Every category set, and none of them honoured. `enabled: false` is a kill
    // switch, so it has to outrank the things it is killing.
    expect(resolve({
      enabled: false,
      ingestDecisionTracing: true,
      ingestCustomMetrics: true,
      ingestPerformanceMetrics: true,
    })).toMatchObject({ decisions: false, custom: false, performance: false });
  });

  it('sends nothing when it is on and nothing else is', () => {
    // A master switch that turned everything on by itself would be a cost
    // control that increases costs.
    expect(resolve({ enabled: true }))
      .toMatchObject({ decisions: false, custom: false, performance: false });
  });

  it('flags that state rather than leaving it to be discovered', () => {
    expect(resolve({ enabled: true }).inert).toBe(true);
    expect(resolve({ enabled: true, ingestCustomMetrics: true }).inert).toBe(false);
  });
});

describe('each category is independent', () => {
  const CATEGORIES = [
    ['ingestDecisionTracing', 'decisions'],
    ['ingestCustomMetrics', 'custom'],
    ['ingestPerformanceMetrics', 'performance'],
  ] as const;

  for (const [flag, field] of CATEGORIES) {
    it(`${flag} turns on ${field} and nothing else`, () => {
      const resolved = resolve({ enabled: true, [flag]: true });

      expect(resolved[field]).toBe(true);
      for (const [, other] of CATEGORIES) {
        if (other !== field) expect(resolved[other]).toBe(false);
      }
    });
  }

  it('treats an unnamed category as off, not as absent-means-yes', () => {
    expect(resolve({ enabled: true, ingestDecisionTracing: true }).custom).toBe(false);
  });

  it('reads an explicit false as off', () => {
    expect(resolve({ enabled: true, ingestDecisionTracing: false }).decisions).toBe(false);
  });
});

describe('the performance switch carries its interval', () => {
  it('reads the object form as a request to sample', () => {
    // `{ intervalSeconds: 30 }` with no `true` anywhere is unambiguous about
    // intent; refusing it on a technicality would be pedantry.
    const resolved = resolve({ enabled: true, ingestPerformanceMetrics: { intervalSeconds: 30 } });

    expect(resolved.performance).toBe(true);
    expect(resolved.performanceIntervalSeconds).toBe(30);
  });

  it('accepts an empty object as on with the default interval', () => {
    expect(resolve({ enabled: true, ingestPerformanceMetrics: {} }))
      .toMatchObject({ performance: true, performanceIntervalSeconds: undefined });
  });
});

describe('the master switch is not optional', () => {
  /**
   * There is no shape in which telemetry is billed without somebody having
   * typed `enabled`. `ObserveConfig` requires it, so the compiler asks the
   * question at the one moment somebody is in a position to answer it; these
   * cover what the answer then means.
   */
  it('sends nothing when it is false, whatever else is set', () => {
    expect(resolve({
      enabled: false,
      ingestDecisionTracing: true,
      ingestCustomMetrics: true,
      ingestPerformanceMetrics: { intervalSeconds: 10 },
    })).toMatchObject({
      decisions: false, custom: false, performance: false, performanceIntervalSeconds: undefined,
    });
  });

  it('keeps the rest of the config meaningful while it is off', () => {
    // Switching ingestion off should not mean deleting the endpoint and the
    // source, and switching it back on should be the same one boolean.
    expect(resolve({ enabled: false, ingestDecisionTracing: true }).decisions).toBe(false);
    expect(resolve({ enabled: true, ingestDecisionTracing: true }).decisions).toBe(true);
  });
});
