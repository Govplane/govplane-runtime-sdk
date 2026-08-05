export interface Target { service: string; resource: string; action: string }

export type Effect =
  | { type: "allow" }
  | { type: "deny" }
  | { type: "kill_switch"; killSwitch: { service: string; reason?: string } }
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

export type Decision =
  | { decision: "allow"; reason: "default" | "rule"; policyKey?: string; ruleId?: string }
  | { decision: "deny"; reason: "default" | "rule"; policyKey?: string; ruleId?: string }
  | { decision: "kill_switch"; reason: "default" | "rule"; policyKey?: string; ruleId?: string; killSwitch: { service: string; reason?: string } }
  | { decision: "throttle"; reason: "default" | "rule"; policyKey?: string; ruleId?: string; throttle: { limit: number; windowSeconds: number; key: string } }
  | { decision: "custom"; reason: "default" | "rule"; policyKey?: string; ruleId?: string; value: string; parsedValue?: unknown };

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

export interface PolicyEngineEvaluateInput {
  target: Target;
  context?: Record<string, unknown>;
}

export interface PolicyEngine {
  evaluate(input: PolicyEngineEvaluateInput): Decision;

  // devuelve Decision con trace opcional según level/sampling/budget
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