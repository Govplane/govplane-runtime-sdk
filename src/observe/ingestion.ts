/**
 * Which streams the application actually asked to send.
 *
 * Data ingestion is metered and billed. §10 of the observability spec works
 * through the arithmetic, and the short version is that per-instance health
 * sampling across a fleet is the single easiest way for a customer to exhaust
 * their project quota — so "on" must be something somebody typed, not something
 * that happened to them.
 *
 * Hence a master switch and three named categories, one per stream:
 *
 *   ingestDecisionTracing     what your policies decided        (stream A)
 *   ingestCustomMetrics       what your application reported    (stream B)
 *   ingestPerformanceMetrics  what this process is doing        (stream C)
 *
 * Every one of them defaults to **off**. A master switch that quietly turned
 * everything on would be a cost control that increases costs.
 *
 * The resolution lives here, alone and pure, because it decides what a customer
 * is billed for and both directions of getting it wrong are silent: too eager
 * and somebody pays for telemetry they never asked for, too strict and somebody
 * opens an empty dashboard a week later.
 */

/** `true`, or an object when the sampling interval needs overriding. */
export type PerformanceSwitch = boolean | { intervalSeconds?: number | undefined };

/** The switch fields on `ObserveConfig`. Read here and nowhere else. */
export interface IngestionSwitches {
  /**
   * The master switch. Required, and deliberately so.
   *
   * Configuring an ingest endpoint is not the same as consenting to be billed
   * for what goes to it, and an optional flag defaulting either way would make
   * one of those two things happen silently. Requiring it means the compiler
   * asks the question at the one moment somebody is in a position to answer it.
   */
  enabled: boolean;

  /** Aggregated counts of what your policies decided. */
  ingestDecisionTracing?: boolean | undefined;

  /**
   * Process resource and runtime health.
   *
   * The expensive one. These are per-instance by nature — each process has its
   * own memory — so the cost scales with replica count rather than with metric
   * count.
   */
  ingestPerformanceMetrics?: PerformanceSwitch | undefined;

  /** Whatever the application reports itself: `event`, `metric` and `record`. */
  ingestCustomMetrics?: boolean | undefined;
}

export interface ResolvedIngestion {
  decisions: boolean;
  performance: boolean;
  custom: boolean;
  /** From the object form of the performance switch, when given. */
  performanceIntervalSeconds: number | undefined;
  /** Ingestion is on and every category is off, which is almost certainly a mistake. */
  inert: boolean;
}

const asSwitch = (
  value: PerformanceSwitch | undefined,
): { on: boolean; intervalSeconds: number | undefined } => {
  if (value === undefined || value === false) return { on: false, intervalSeconds: undefined };
  if (value === true) return { on: true, intervalSeconds: undefined };
  // The object form is itself a request to sample, so `{}` means on.
  return { on: true, intervalSeconds: value.intervalSeconds };
};

export const resolveIngestion = (config: IngestionSwitches): ResolvedIngestion => {
  const performance = asSwitch(config.ingestPerformanceMetrics);

  /**
   * Off outranks everything below it.
   *
   * Deliberately not the same as omitting the whole config: a deployment that
   * flips one boolean to stop ingesting should not have to delete the endpoint
   * and the source alongside it, and should be able to put it back by flipping
   * the boolean again.
   */
  if (!config.enabled) {
    return {
      decisions: false,
      performance: false,
      custom: false,
      performanceIntervalSeconds: undefined,
      inert: true,
    };
  }

  const decisions = config.ingestDecisionTracing === true;
  const custom = config.ingestCustomMetrics === true;

  return {
    decisions,
    custom,
    performance: performance.on,
    performanceIntervalSeconds: performance.intervalSeconds,
    inert: !decisions && !custom && !performance.on,
  };
};

/**
 * What to say when the application uses a stream it did not enable.
 *
 * Raised once per category rather than per call — this is reachable from a
 * request path, and a warning per request would be its own outage.
 */
export const disabledCategoryMessage = (method: string): string =>
  `Govplane: client.observe.${method}() was called but custom metrics are not enabled, `
  + 'so nothing was recorded. Set observe.ingestCustomMetrics: true to send them.';
