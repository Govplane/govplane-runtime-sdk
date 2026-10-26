export interface Target { service: string; resource: string; action: string }

/**
 * What a `requires_approval` effect tells the host about the approval it wants.
 *
 * Every field is optional and none is enforced by the engine: the SDK gates the
 * action and hands the descriptor back untouched, and the host routes, waits
 * and expires as it sees fit — exactly as a throttle is a description of a
 * limit rather than a limiter.
 */
export interface ApprovalDescriptor {
  reason?: string;
  approvers?: string[];
  expiresInSeconds?: number;
}

export type Effect =
  | { type: "allow" }
  | { type: "deny" }
  | { type: "kill_switch"; killSwitch: { service: string; reason?: string } }
  | { type: "requires_approval"; approval?: ApprovalDescriptor }
  | { type: "throttle"; throttle: { limit: number; windowSeconds: number; key: string } }
  | { type: "custom"; value: string };

export type WhenAstV1 =
  // logical (canonical: conditions / arg, legacy: args / arg)
  | { op: "and" | "or"; conditions: WhenAstV1[] }
  | { op: "and" | "or"; args: WhenAstV1[] }
  | { op: "not"; condition: WhenAstV1 }
  | { op: "not"; arg: WhenAstV1 }
  // comparison (neq is the canonical alias; ne kept for legacy bundles)
  | { op: "eq" | "neq" | "ne" | "gt" | "gte" | "lt" | "lte"; path: string; value: any }
  | { op: "in"; path: string; values: any[] }
  | { op: "exists"; path: string };

export interface RuntimeRule {
  id: string;
  status: "active" | "disabled";
  priority: number;
  target: Target;
  when?: WhenAstV1;
  /** Effect applied when `when` evaluates to true (falls back to `effect`). */
  thenEffect?: Effect;
  /** Effect applied when `when` evaluates to false (rule is skipped if absent). */
  elseEffect?: Effect;
  effect: Effect;
  description?: string;
}

export type PolicyDefault =
  | { effect: "allow" }
  | { effect: "deny" }
  | { effect: "kill_switch"; killSwitch: { service: string; reason?: string } }
  | { effect: "requires_approval"; approval?: ApprovalDescriptor }
  | { effect: "throttle"; throttle: { limit: number; windowSeconds: number; key: string } }
  | { effect: "custom"; customEffect: string };

export interface RuntimePolicy {
  policyKey: string;
  activeVersion: number;
  defaults?: PolicyDefault;
  rules: RuntimeRule[];
}

/**
 * A bundle as the engine sees it.
 *
 * `orgId`, `projectId` and `generatedAt` are optional as of 2.0. They address a
 * bundle within the control plane and are required when one is fetched from
 * Govplane Cloud, but a bundle built locally with `govplane build` carries no
 * scope at all and evaluates perfectly well without one. The engine has never
 * read them.
 */
export interface RuntimeBundleV1 {
  schemaVersion: 1;
  orgId?: string;
  projectId?: string;
  env: string;
  generatedAt?: string;
  policies: RuntimePolicy[];
}

/**
 * Why a decision came out the way it did.
 *
 * `rule` and `default` are the two answers a bundle can give. `signal_missing`
 * is the engine refusing to consult the bundle at all, because a signal the
 * client declared it depends on was not supplied — see `SignalsConfig`. It is
 * only ever paired with the `onMissing` outcome, and it carries the names of
 * the signals that were missing.
 */
export type DecisionReason = "default" | "rule" | "signal_missing";

export type Decision =
  | { decision: "allow"; reason: DecisionReason; policyKey?: string; ruleId?: string; missingSignals?: string[] }
  | { decision: "deny"; reason: DecisionReason; policyKey?: string; ruleId?: string; missingSignals?: string[] }
  | { decision: "kill_switch"; reason: DecisionReason; policyKey?: string; ruleId?: string; killSwitch: { service: string; reason?: string }; missingSignals?: string[] }
  | { decision: "requires_approval"; reason: DecisionReason; policyKey?: string; ruleId?: string; approval?: ApprovalDescriptor }
  | { decision: "throttle"; reason: DecisionReason; policyKey?: string; ruleId?: string; throttle: { limit: number; windowSeconds: number; key: string } }
  | { decision: "custom"; reason: DecisionReason; policyKey?: string; ruleId?: string; value: string; parsedValue?: unknown };

export type TraceDiscardReason =
| "disabled"
| "target_mismatch"
| "when_false"
| "invalid_effect";

export interface TraceRule {
  policyKey: string;
  ruleId: string;
  priority: number;
  effectType?: string;
  matched: boolean;
  discardedReason?: TraceDiscardReason;
}

export interface DecisionTrace {
  evaluatedAt: string; // ISO
  target: Target;
  summary: {
    policiesSeen: number;
    rulesSeen: number;
    matched: number;
    considered: {
      kill_switch: number;
      deny: number;
      requires_approval: number;
      throttle: number;
      allow: number;
      custom: number;
    };
  };
  winner?: {
    policyKey: string;
    ruleId: string;
    effectType: string;
    priority: number;
  };
  rules: TraceRule[]; // safe list
}

export type DecisionWithTrace = Decision & { trace: DecisionTrace };

export type TraceLevel = "off" | "errors" | "sampled" | "full";

export type TraceMode = "compact" | "full"; // si lo sigues manteniendo por compat

export interface TraceOptions {
  level?: TraceLevel;

  // compat (si aún lo usas internamente)
  mode?: TraceMode;

  sampling?: number; // 0..1
  force?: boolean;

  budget?: {
    maxTraces: number;
    windowMs: number;
  };
}

/**
 * What to evaluate: a target, or one named rule.
 *
 * Naming a rule addresses it directly and skips target matching entirely — the
 * rule's own `target` says what it is about, not whether it was selected. It is
 * for call sites that already know which rule they mean, where restating the
 * service, resource and action is repetition the caller can get wrong.
 *
 * `context` is required by neither form and needed by both in practice: a rule
 * without context can only ever reach its unconditional effect.
 */
export type PolicyEngineEvaluateInput =
  | {
    target: Target;
    context?: Record<string, unknown>;
  }
  | {
    /** Rule to evaluate. Ambiguous across policies unless `policyKey` is given. */
    ruleId: string;
    /** Narrows the search to one policy, and makes the address unambiguous. */
    policyKey?: string;
    context?: Record<string, unknown>;
  };

/** True when the caller addressed a rule rather than a target. */
export const isRuleInput = (
  input: PolicyEngineEvaluateInput,
): input is Extract<PolicyEngineEvaluateInput, { ruleId: string }> => (
  typeof (input as { ruleId?: unknown }).ruleId === 'string'
);

/**
 * How the decision should be returned.
 *
 * All three are lossy on purpose, for call sites that branch on the outcome and
 * never read the rest. Anything that needs a throttle's limit, a kill switch's
 * service or a custom effect's value must read the full decision — which is why
 * `evaluateWithTrace` ignores these and always returns the object.
 *
 * At most one may be set: they are three answers to the same question, and a
 * caller who sets two has a misunderstanding worth surfacing rather than a
 * preference worth guessing at.
 */
export interface EvaluateOptions {
  /**
   * `allow` and `custom` are true; `deny`, `kill_switch`, `requires_approval`
   * and `throttle` are false.
   */
  asBoolean?: boolean;
  /** The same mapping, as `1` and `0`. */
  asBinary?: boolean;
  /** The `decision` string alone, with no reason, policy or rule. */
  effectOnly?: boolean;
}

export interface PolicyEngine {
  // Overloaded so the return type follows the option, rather than handing back a
  // union every call site has to narrow.
  evaluate(input: PolicyEngineEvaluateInput): Decision;
  evaluate(input: PolicyEngineEvaluateInput, options: { asBoolean: true }): boolean;
  evaluate(input: PolicyEngineEvaluateInput, options: { asBinary: true }): 0 | 1;
  evaluate(
    input: PolicyEngineEvaluateInput,
    options: { effectOnly: true },
  ): Decision['decision'];
  evaluate(
    input: PolicyEngineEvaluateInput,
    options?: EvaluateOptions,
  ): Decision | boolean | 0 | 1 | Decision['decision'];

  // devuelve Decision con trace opcional según level/sampling/budget.
  // Deliberately unshaped: a trace explains a decision, so reducing the decision
  // to a boolean beside it would leave the explanation with nothing to explain.
  evaluateWithTrace(
    input: PolicyEngineEvaluateInput,
    options?: TraceOptions
  ): DecisionWithOptionalTrace;

  // ✅ nuevo: solo hace algo si traceSinkAsync está configurado
  flushTraces(): Promise<void>;
}

export interface DecisionTraceCompact {
  traceId: string;
  sampled: "forced" | "random";
  evaluatedAt: string;
  target: Target;
  summary: {
    policiesSeen: number;
    rulesSeen: number;
    matched: number;
    considered: {
      kill_switch: number;
      deny: number;
      requires_approval: number;
      throttle: number;
      allow: number;
      custom: number;
    };
  };
  winner?: {
    policyKey: string;
    ruleId: string;
    effectType: string;
    priority: number;
  };
}

export type DecisionTraceFull = DecisionTraceCompact & {
  rules: TraceRule[];
};

export type DecisionWithOptionalTrace = Decision & { trace?: DecisionTraceCompact | DecisionTraceFull };

export interface StructuredTraceEvent {
  v: 1;
  ts: string; // ISO
  traceId: string;
  sampled: "forced" | "random" | "errors";
  level: TraceLevel;
  target: Target;
  decision: Decision["decision"];
  reason: Decision["reason"];
  winner?: {
    policyKey: string;
    ruleId: string;
    effectType: string;
    priority: number;
  };
  summary: {
    policiesSeen: number;
    rulesSeen: number;
    matched: number;
    considered: {
      kill_switch: number;
      deny: number;
      requires_approval: number;
      throttle: number;
      allow: number;
      custom: number;
    };
  };
  // Only if level === "full"
  rules?: {
    policyKey: string;
    ruleId: string;
    priority: number;
    effectType?: string;
    matched: boolean;
    discardedReason?: string;
  }[];
}

export type TraceSink = (evt: StructuredTraceEvent) => void;
export type TraceSinkAsync = (evt: StructuredTraceEvent) => Promise<void>;

export type TraceQueueDropPolicy = "drop_new" | "drop_old";

export type DecisionTraceHook = (evt: StructuredTraceEvent) => void;

export interface RuntimeClientOptions {
  // ... lo que ya tengas

  trace?: {
    level?: TraceLevel;        // default: "errors" en prod
    sampling?: number;         // default 0.01
    budget?: { maxTraces: number; windowMs: number }; // default safe
    onDecisionTrace?: DecisionTraceHook; // hook para logs/otel
  };
}