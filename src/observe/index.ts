/**
 * Govplane observability — optional, opt-in, and inert until configured.
 *
 * Imported as a subpath so that nothing here reaches an application that does
 * not ask for it:
 *
 *   import { createDecisionAggregator } from '@govplane/runtime-sdk/observe';
 *
 * The module ships inside the SDK rather than as a separate package, which
 * means the package boundary is no longer what keeps Cloud code out of a local
 * deployment. Three things stand in for it, and all three are deliberate:
 *
 *   - the subpath export, so an unused import is never resolved;
 *   - `sideEffects: false`, so a bundler can drop it entirely;
 *   - no import of this module anywhere under `src/` outside `observe/`, so the
 *     main entry point never pulls it in transitively.
 *
 * The last one is the easy one to lose. It is worth a test rather than a
 * convention.
 */

export {
  createObserver, type RunningObserver, type RunningObserverConfig,
} from './createObserver.js';
export {
  createClientObserver, type ClientObserver, type ClientObserverOptions,
} from './attach.js';
export {
  createTransport, toDataPoints, type Transport, type TransportConfig,
  MAX_POINTS_PER_BATCH, QUOTA_COOLOFF_MS, DECISION_METRIC,
} from './transport.js';
export { resolveInstanceId } from './instance.js';
export {
  RecordBuffer, RECORD_LIMITS, type RecordLevel, type RecordOptions,
} from './records.js';
export {
  CustomAggregator, CUSTOM_LIMITS,
  type CustomCategory, type EventOptions, type MetricAggregation, type MetricOptions,
} from './custom.js';
export {
  createHealthMonitor, readContainerMemoryLimit, HEALTH_METRICS,
  type HealthConfig, type HealthMonitor,
} from './health.js';
export {
  createDecisionAggregator,
  bucketStart,
  resolveRollupSeconds,
  DEFAULT_ROLLUP_SECONDS,
  DEFAULT_MAX_SERIES,
  OVERFLOW_KEY,
} from './aggregator.js';

export type {
  DecisionCounter,
  DecisionOutcome,
  DecisionSeriesKey,
  DecisionsConfig,
  Observer,
  ObserverConfig,
  ObserverErrorContext,
  ObserverErrorHandler,
} from './types.js';
