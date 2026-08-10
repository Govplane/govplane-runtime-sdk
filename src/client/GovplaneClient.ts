import { createPolicyEngine } from '../engine/createPolicyEngine.js';
import type { ContextPolicy } from '../engine/context.js';
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
  close(): void;
}

export interface ClientOptions {
  engine?: EngineOptions | undefined;
  trace?: TraceOptionsConfig | undefined;
  /** Called when a background reload fails. The previous bundle stays in force. */
  onError?: ((error: unknown) => void) | undefined;
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
    };
  };

  const adopt = (loaded: LoadedBundle): void => {
    current = loaded;
    loadedAt = new Date().toISOString();
  };

  source.start?.({
    onChange: adopt,
    onError: (error) => {
      // A failed reload must never replace a good bundle with nothing. The
      // application is told; evaluation continues against what it already has.
      options.onError?.(error);
    },
  });

  return {
    evaluate: ((input: PolicyEngineEvaluateInput, shape?: EvaluateOptions) => (
      engine.evaluate(input, shape)
    )) as GovplaneClient['evaluate'],
    evaluateWithTrace: (input, traceOptions) => engine.evaluateWithTrace(input, traceOptions),
    bundle: () => current.bundle,
    status,
    async reload() {
      adopt(await source.load());
      return status();
    },
    close() {
      source.stop();
    },
  };
};
