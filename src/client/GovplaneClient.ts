import { createPolicyEngine } from '../engine/createPolicyEngine.js';
import { shapeDecision } from '../engine/decisionShape.js';
import { computeChecksum } from '../bundle/canonical.js';
import { createRecorder, DISABLED_RECORD_STATUS } from '../records/recorder.js';
import { validateRecordConfig } from '../records/validateRecordConfig.js';
import type { BundleSnapshot, RecordConfig, RecordStatus } from '../records/types.js';
import type { ContextPolicy } from '../engine/context.js';
import type { SignalsConfig, SignalsOnMissing } from '../engine/signals.js';
import { declaredSignalNames, normalizeSignals } from '../engine/signals.js';
import type {
  Decision, DecisionWithOptionalTrace, EvaluateOptions, PolicyEngine, PolicyEngineEvaluateInput,
  StructuredTraceEvent, TraceOptions, TraceQueueDropPolicy,
} from '../engine/types.js';
import type { BundleOrigin, RuntimeBundle } from '../bundle/types.js';
import type { BundleSource, LoadedBundle } from '../source/types.js';

/**
 * The client an application holds.
 *
 * It owns a source, a verified bundle and one engine. Local and remote clients
 * differ only in the source they were built with — the evaluation path below is
 * identical, which is the property 1.x lacked.
 */

export interface EngineOptions {
  /** Reject context values the configured context policy would reject. */
  validateContext?: boolean;
  contextPolicy?: ContextPolicy;
  /** JSON-parse custom effect values into `parsedValue`. */
  parseCustomEffect?: boolean;
  /**
   * Context keys the policies depend on — classifier scores, detector
   * verdicts — and what evaluation returns when one is absent. See
   * `docs/ai-signals.md`.
   */
  signals?: SignalsConfig;
}

export interface SignalsStatus {
  required: string[];
  onMissing: SignalsOnMissing;
}

export interface TraceOptionsConfig {
  defaults?: TraceOptions;
  onDecisionTrace?: (event: StructuredTraceEvent) => void;
  onDecisionTraceAsync?: (event: StructuredTraceEvent) => Promise<void>;
  queueMax?: number;
  dropPolicy?: TraceQueueDropPolicy;
  onTraceError?: (error: unknown) => void;
}

export interface ClientStatus {
  origin: BundleOrigin;
  location: string;
  bundleVersion: number | undefined;
  checksum: string | undefined;
  env: string | undefined;
  signature: { status: string; algorithm?: string | undefined; keyId?: string | undefined };
  policies: number;
  loadedAt: string;
  /** Present only when `engine.signals` was configured. */
  signals?: SignalsStatus;
  /** Always present; `enabled: false` with zero counters when `record` is not configured. */
  records: RecordStatus;
}

export interface GovplaneClient {
  /**
   * Evaluates a target, or one rule named directly.
   *
   * The options are per call rather than per client on purpose: they change what
   * the method returns, and a client-wide setting would make `evaluate` have a
   * different type in different files for a reason invisible at the call site.
   */
  evaluate(input: PolicyEngineEvaluateInput): Decision;
  evaluate(input: PolicyEngineEvaluateInput, options: { asBoolean: true }): boolean;
  evaluate(input: PolicyEngineEvaluateInput, options: { asBinary: true }): 0 | 1;
  evaluate(input: PolicyEngineEvaluateInput, options: { effectOnly: true }): Decision['decision'];
  evaluate(
    input: PolicyEngineEvaluateInput,
    options?: EvaluateOptions,
  ): Decision | boolean | 0 | 1 | Decision['decision'];
  evaluateWithTrace(
    input: PolicyEngineEvaluateInput,
    options?: TraceOptions,
  ): DecisionWithOptionalTrace;
  /** The bundle currently in force. */
  bundle(): RuntimeBundle;
  status(): ClientStatus;
  /** Re-reads the source now, regardless of any watch or poll interval. */
  reload(): Promise<ClientStatus>;
  /**
   * Delivers every queued decision record to the sink and resolves once the
   * sink has taken them. Resolves immediately when records are off. For hosts
   * that want certainty before exit; `close()` flushes too, but with a bound.
   */
  flushRecords(): Promise<void>;
  /**
   * Stops watching or polling and flushes records with a bounded wait. Never
   * blocks shutdown on a slow sink: call `flushRecords()` first if losing the
   * tail is unacceptable.
   */
  close(): void;
}

export interface ClientOptions {
  engine?: EngineOptions | undefined;
  trace?: TraceOptionsConfig | undefined;
  /**
   * Called when a background reload fails (the previous bundle stays in
   * force), and when a decision record sink throws or rejects (the error has
   * code `RECORD_SINK_ERROR`; the decision already returned is unaffected).
   */
  onError?: ((error: unknown) => void) | undefined;
  /**
   * Emit a record of every decision to a sink the application provides. Off
   * unless configured: no queue, no timer, no counters. See
   * `docs/decision-records.md`.
   */
  record?: RecordConfig | undefined;
  /**
   * Called with every decision, unsampled, before output shaping.
   *
   * The counting companion to `trace.onDecisionTrace`. A trace carries full
   * detail and is therefore sampled and budgeted — `evaluate()` emits none at
   * all — so it can describe a decision but cannot count one. This fires on
   * every evaluation through either method, and receives the decision while
   * `policyKey` and `ruleId` are still on it.
   *
   * Generic and vendor-neutral, like the trace hook: Govplane's own
   * observability module is one consumer, and a caller may equally point it at
   * their own metrics client.
   *
   * It runs on the hot path. Keep it cheap; anything thrown is swallowed.
   */
  onDecision?: ((decision: Decision) => void) | undefined;
}

/**
 * Whether to enforce the context policy.
 *
 * The engine's own default is `true` against `DEFAULT_CONTEXT_POLICY`, which is
 * a **seven-key sample** — `plan`, `country`, `requestTier`, `feature`,
 * `amount`, `isAuthenticated`, `role`. Enforcing it against a real application
 * rejects the very keys that application's own rules read, so every evaluation
 * throws until the caller discovers the flag. That is a sharp edge, not a
 * safety feature.
 *
 * A client therefore enforces the policy exactly when one has been configured.
 * Pin `contextPolicy` to your application's real key set and it is enforced;
 * pin nothing and nothing is enforced. `validateContext` still overrides
 * explicitly in either direction.
 */
const shouldValidateContext = (engine: EngineOptions | undefined): boolean => {
  if (engine?.validateContext !== undefined) {
    return engine.validateContext;
  }
  return engine?.contextPolicy !== undefined;
};

const buildEngine = (
  getBundle: () => RuntimeBundle,
  options: ClientOptions,
): PolicyEngine => createPolicyEngine({
  getBundle,
  validateContext: shouldValidateContext(options.engine),
  ...(options.engine?.contextPolicy === undefined
    ? {}
    : { contextPolicy: options.engine.contextPolicy }),
  ...(options.engine?.parseCustomEffect === undefined
    ? {}
    : { parseCustomEffect: options.engine.parseCustomEffect }),
  ...(options.engine?.signals === undefined ? {} : { signals: options.engine.signals }),
  ...(options.trace?.defaults === undefined ? {} : { traceDefaults: options.trace.defaults }),
  ...(options.trace?.onDecisionTrace === undefined
    ? {}
    : { traceSink: options.trace.onDecisionTrace }),
  ...(options.trace?.onDecisionTraceAsync === undefined
    ? {}
    : { traceSinkAsync: options.trace.onDecisionTraceAsync }),
  ...(options.trace?.queueMax === undefined ? {} : { traceQueueMax: options.trace.queueMax }),
  ...(options.trace?.dropPolicy === undefined
    ? {}
    : { traceQueueDropPolicy: options.trace.dropPolicy }),
  ...(options.trace?.onTraceError === undefined
    ? {}
    : { onTraceSinkError: options.trace.onTraceError }),
  ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision }),
});

/** How long `close()` waits for the sink before letting the process go. */
const CLOSE_FLUSH_TIMEOUT_MS = 2000;

/**
 * What a record says about the bundle that produced it.
 *
 * Computed once per load rather than once per evaluation: the checksum
 * fallback hashes the canonical payload, which is not a per-decision cost.
 */
const snapshotOf = (loaded: LoadedBundle, origin: BundleOrigin): BundleSnapshot => ({
  ...(loaded.bundle.bundleVersion === undefined ? {} : { version: loaded.bundle.bundleVersion }),
  ...(loaded.bundle.generatedAt === undefined ? {} : { generatedAt: loaded.bundle.generatedAt }),
  checksum: loaded.bundle.checksum ?? computeChecksum(loaded.bundle),
  signature: {
    ...(loaded.verification.signature.algorithm === undefined
      ? {}
      : { algorithm: loaded.verification.signature.algorithm }),
    verified: loaded.verification.signature.status === 'verified',
  },
  origin,
});

/**
 * Builds a client over an already-loaded bundle.
 *
 * The first load happens before construction, so a client always exists with a
 * verified bundle in hand. There is no window in which `evaluate()` could be
 * called against nothing — a state 1.x had, and reported as `hasValidBundle`.
 */
export const createClient = (
  source: BundleSource,
  initial: LoadedBundle,
  options: ClientOptions = {},
): GovplaneClient => {
  let current = initial;
  let loadedAt = new Date().toISOString();

  const engine = buildEngine(() => current.bundle, options);

  // Validated before anything else is built: a `record` block that names a
  // key the PII heuristic flags must fail here, on line one, not at runtime.
  const recorder = options.record === undefined
    ? undefined
    : createRecorder(validateRecordConfig(options.record, options.engine), {
      onError: (error) => { options.onError?.(error); },
    });
  const { origin } = source.describe();
  let snapshot: BundleSnapshot | undefined = recorder && snapshotOf(current, origin);

  // Normalised again here purely for reporting; the engine validated it and
  // threw on anything malformed before this line was reached.
  const signals = options.engine?.signals === undefined
    ? undefined
    : normalizeSignals(options.engine.signals);

  const status = (): ClientStatus => {
    const description = source.describe();
    return {
      origin: description.origin,
      location: description.location,
      bundleVersion: current.bundle.bundleVersion,
      checksum: current.bundle.checksum,
      env: current.bundle.env,
      signature: current.verification.signature,
      policies: current.bundle.policies.length,
      loadedAt,
      ...(signals === undefined
        ? {}
        : { signals: { required: declaredSignalNames(signals), onMissing: signals.onMissing } }),
      records: recorder === undefined ? DISABLED_RECORD_STATUS : recorder.status(),
    };
  };

  const adopt = (loaded: LoadedBundle): void => {
    current = loaded;
    loadedAt = new Date().toISOString();
    if (recorder) snapshot = snapshotOf(loaded, origin);
  };

  source.start?.({
    onChange: adopt,
    onError: (error) => {
      // A failed reload must never replace a good bundle with nothing. The
      // application is told; evaluation continues against what it already has.
      options.onError?.(error);
    },
  });

  /**
   * Recording sits here, at the client, and not in the engine or on
   * `onDecision`. Here is where the bundle in force is known, and because the
   * whole call is synchronous the snapshot a record carries is the one that
   * answered — a reload between two calls lands cleanly on one side or the
   * other. `evaluateWithTrace` runs the engine's core twice on a traced call;
   * one record per call is only guaranteed by recording after it returns.
   */
  const evaluate: GovplaneClient['evaluate'] = recorder === undefined
    ? ((input: PolicyEngineEvaluateInput, shape?: EvaluateOptions) => (
      engine.evaluate(input, shape)
    )) as GovplaneClient['evaluate']
    : ((input: PolicyEngineEvaluateInput, shape?: EvaluateOptions) => {
      const decision = engine.evaluate(input);
      recorder.observe(decision, input, snapshot!);
      return shapeDecision(decision, shape);
    }) as GovplaneClient['evaluate'];

  const evaluateWithTrace: GovplaneClient['evaluateWithTrace'] = recorder === undefined
    ? (input, traceOptions) => engine.evaluateWithTrace(input, traceOptions)
    : (input, traceOptions) => {
      const traced = engine.evaluateWithTrace(input, traceOptions);
      recorder.observe(traced, input, snapshot!);
      return traced;
    };

  return {
    evaluate,
    evaluateWithTrace,
    bundle: () => current.bundle,
    status,
    async reload() {
      adopt(await source.load());
      return status();
    },
    flushRecords: () => (recorder === undefined ? Promise.resolve() : recorder.flush()),
    close() {
      source.stop();
      // Ships what is queued, but never blocks shutdown on a slow sink.
      void recorder?.close(CLOSE_FLUSH_TIMEOUT_MS);
    },
  };
};
