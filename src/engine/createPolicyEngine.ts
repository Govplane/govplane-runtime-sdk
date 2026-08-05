import { randomUUID } from "node:crypto";
import type { Decision, RuntimeBundleV1, Target, PolicyEngine } from "./types.js";
import type { ContextPolicy } from "./context.js";
import { validateContext, DEFAULT_CONTEXT_POLICY } from "./context.js";
import { evalWhen } from "./when.js";
import type { TraceOptions, DecisionWithOptionalTrace, TraceSink, TraceSinkAsync, TraceQueueDropPolicy } from "./types.js";
import { TraceDispatcher } from "./traceDispatcher.js";
import { emitTraceIfAny } from "./emitTrace.js";

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function safeEffectType(effect: any): string | undefined {
  const t = effect?.type;
  return typeof t === "string" ? t : undefined;
}

/**
 * A correlation id for one decision trace.
 *
 * The previous implementation reached for `require("node:crypto")`, which
 * cannot work in this package — it is native ESM. A static import replaces the
 * whole fallback chain: `randomUUID` has been stable in `node:crypto` since
 * long before the Node version this package supports.
 */
function makeTraceId(): string {
  return randomUUID();
}

interface EngineOpts {
  getBundle: () => RuntimeBundleV1 | undefined;

  // default: true
  validateContext?: boolean;

  // policy configurable (PII-safe)
  contextPolicy?: ContextPolicy;

  // optional: default trace options for evaluateWithTrace()
  traceDefaults?: TraceOptions;

  // Event emitter for trace sink
  traceSink?: TraceSink;
  traceSinkAsync?: TraceSinkAsync;
  traceQueueMax?: number; // default 1000
  traceQueueDropPolicy?: TraceQueueDropPolicy; // "drop_new" | "drop_old"
  onTraceSinkError?: (err: unknown) => void;

  /**
   * When true, custom effect `value` strings are JSON-parsed and the result
   * is attached as `parsedValue` on the decision.  Parsing errors are
   * silently swallowed and `parsedValue` is left undefined.
   */
  parseCustomEffect?: boolean;
}

interface EvaluateInput {
  target: Target;
  context?: Record<string, unknown>;
}

interface Match {
  policyKey: string;
  ruleId: string;
  priority: number;
  effect: any;
}

function targetMatch(a: Target, b: Target) {
  return a.service === b.service && a.resource === b.resource && a.action === b.action;
}

function byRuleOrder(a: Match, b: Match) {
  // priority desc, policyKey asc, ruleId asc
  const pr = (Number(b.priority) || 0) - (Number(a.priority) || 0);
  if (pr !== 0) return pr;
  const pk = String(a.policyKey).localeCompare(String(b.policyKey));
  if (pk !== 0) return pk;
  return String(a.ruleId).localeCompare(String(b.ruleId));
}

function throttleStrictness(th: { limit: number; windowSeconds: number }) {
  const limit = Number(th?.limit);
  const windowSeconds = Number(th?.windowSeconds);
  const rate = windowSeconds > 0 ? limit / windowSeconds : Number.POSITIVE_INFINITY; // lower => stricter
  return { rate, limit, windowSeconds };
}

// Simple in-memory budget: N traces per windowMs (default 60/min)
function makeTraceBudget(maxTraces: number, windowMs: number) {
  let windowStart = Date.now();
  let used = 0;

  return {
    allow(): boolean {
      const now = Date.now();
      if (now - windowStart >= windowMs) {
        windowStart = now;
        used = 0;
      }
      if (used >= maxTraces) return false;
      used += 1;
      return true;
    },
  };
}

export function createPolicyEngine(opts: EngineOpts): PolicyEngine {
  const budget = makeTraceBudget(
    Number.isFinite(opts.traceDefaults?.budget?.maxTraces) ? (opts.traceDefaults!.budget!.maxTraces) : 60,
    Number.isFinite(opts.traceDefaults?.budget?.windowMs) ? (opts.traceDefaults!.budget!.windowMs) : 60_000,
  );

  // Initialize trace dispatcher if async sink provided
  const dispatcher =
  opts.traceSinkAsync
    ? new TraceDispatcher({
        sinkAsync: opts.traceSinkAsync,
        max: Number.isFinite(opts.traceQueueMax) ? (opts.traceQueueMax as number) : 1000,
        dropPolicy: opts.traceQueueDropPolicy ?? "drop_new",
        onError: opts.onTraceSinkError,
      })
    : undefined;

  function coreEvaluate(input: EvaluateInput, wantTrace: boolean) {
    const bundle = opts.getBundle();
    const ctx = input.context ?? {};

    if (opts.validateContext !== false) {
      validateContext(ctx, opts.contextPolicy ?? DEFAULT_CONTEXT_POLICY);
    }

    const traceBase = wantTrace
      ? {
          traceId: makeTraceId(),
          sampled: "random" as const, // overwritten if forced
          evaluatedAt: new Date().toISOString(),
          target: input.target,
          summary: {
            policiesSeen: 0,
            rulesSeen: 0,
            matched: 0,
            considered: { kill_switch: 0, deny: 0, throttle: 0, allow: 0, custom: 0 },
          },
          rules: [] as any[],
        }
      : null;

    // deny-by-default if bundle missing/invalid
    if (!bundle || bundle.schemaVersion !== 1) {
      const decision: Decision = { decision: "deny", reason: "default" };
      if (!wantTrace) return decision;

      return {
        ...decision,
        trace: {
          ...traceBase!,
          winner: undefined,
        },
      };
    }

    const kills: Match[] = [];
    const denies: Match[] = [];
    const throttles: Match[] = [];
    const allows: Match[] = [];
    const customs: Match[] = [];

    const policies = bundle.policies ?? [];
    if (wantTrace) traceBase!.summary.policiesSeen = policies.length;

    for (const p of policies) {
      const policyKey = String((p as any).policyKey ?? "");
      const rules = (p as any).rules ?? [];

      // Track whether any rule in this policy produced a match for this target
      let policyHadMatch = false;

      // Whether this policy governs the target at all: at least one active rule
      // aims at it, however that rule's condition then resolved. A policy about
      // refunds has nothing to say about a login, and its default must not be
      // read as an opinion on one.
      let policyGovernsTarget = false;

      for (const r of rules) {
        if (wantTrace) traceBase!.summary.rulesSeen += 1;

        const ruleId = String(r?.id ?? "");
        const priority = Number(r?.priority ?? 0);

        // Scope is what the policy is *about*, so it is read before anything
        // that can discard a rule. A rule aimed here still places the policy in
        // scope while switched off: otherwise disabling one rule would swap the
        // policy's own default for the global deny-by-default, silently denying
        // everything that rule covered — far more than turning a rule off should
        // ever mean.
        if (r?.target && targetMatch(r.target, input.target)) {
          policyGovernsTarget = true;
        }

        // disabled
        if (r?.status !== "active") {
          if (wantTrace) {
            traceBase!.rules.push({
              policyKey,
              ruleId,
              priority,
              effectType: safeEffectType(r?.effect),
              matched: false,
              discardedReason: "disabled",
            });
          }
          continue;
        }

        // target mismatch
        if (!r?.target || !targetMatch(r.target, input.target)) {
          if (wantTrace) {
            traceBase!.rules.push({
              policyKey,
              ruleId,
              priority,
              effectType: safeEffectType(r?.effect),
              matched: false,
              discardedReason: "target_mismatch",
            });
          }
          continue;
        }

        // when evaluation with thenEffect / elseEffect support
        let resolvedEffect: any;
        if (r.when !== undefined) {
          const whenResult = evalWhen(r.when, ctx);
          if (whenResult) {
            // when is true: use thenEffect, falling back to effect
            resolvedEffect = r.thenEffect ?? r.effect;
          } else {
            // when is false: use elseEffect or skip the rule entirely
            if (r.elseEffect) {
              resolvedEffect = r.elseEffect;
            } else {
              if (wantTrace) {
                traceBase!.rules.push({
                  policyKey,
                  ruleId,
                  priority,
                  effectType: safeEffectType(r?.effect),
                  matched: false,
                  discardedReason: "when_false",
                });
              }
              continue;
            }
          }
        } else {
          resolvedEffect = r.effect;
        }

        const effectType = safeEffectType(resolvedEffect);

        // invalid effect
        if (!effectType) {
          if (wantTrace) {
            traceBase!.rules.push({
              policyKey,
              ruleId,
              priority,
              effectType: undefined,
              matched: false,
              discardedReason: "invalid_effect",
            });
          }
          continue;
        }

        // matched
        policyHadMatch = true;
        if (wantTrace) {
          traceBase!.summary.matched += 1;
          traceBase!.rules.push({
            policyKey,
            ruleId,
            priority,
            effectType,
            matched: true,
          });
        }

        const m: Match = { policyKey, ruleId, priority, effect: resolvedEffect };

        if (effectType === "kill_switch") {
          kills.push(m);
          if (wantTrace) traceBase!.summary.considered.kill_switch += 1;
        } else if (effectType === "deny") {
          denies.push(m);
          if (wantTrace) traceBase!.summary.considered.deny += 1;
        } else if (effectType === "throttle") {
          throttles.push(m);
          if (wantTrace) traceBase!.summary.considered.throttle += 1;
        } else if (effectType === "allow") {
          allows.push(m);
          if (wantTrace) traceBase!.summary.considered.allow += 1;
        } else if (effectType === "custom") {
          customs.push(m);
          if (wantTrace) traceBase!.summary.considered.custom += 1;
        }
      }

      // ── Per-policy default ─────────────────────────────────────────────────
      // Applies when this policy governs the target but none of its rules fired
      // — a rule aimed at it whose condition turned out false, for instance.
      //
      // Both halves matter. Without `policyGovernsTarget`, every policy in the
      // bundle would answer every question: one policy that denies by default
      // would deny every target in the bundle, including those another policy
      // explicitly allows, because deny outranks allow. A policy with no rules
      // governs nothing and is silent everywhere; targets no policy covers still
      // fall to the deny-by-default below, so silence never means permission.
      if (!policyHadMatch && policyGovernsTarget) {
        const defaults: any = (p as any).defaults;
        if (defaults?.effect) {
          const defEffectType = String(defaults.effect);
          // Build a synthetic Effect object from the defaults descriptor
          let syntheticEffect: any;
          if (defEffectType === "custom") {
            syntheticEffect = { type: "custom", value: String(defaults.customEffect ?? "") };
          } else if (defEffectType === "throttle" && defaults.throttle) {
            syntheticEffect = { type: "throttle", throttle: defaults.throttle };
          } else if (defEffectType === "kill_switch" && defaults.killSwitch) {
            syntheticEffect = { type: "kill_switch", killSwitch: defaults.killSwitch };
          } else if (defEffectType === "allow" || defEffectType === "deny") {
            syntheticEffect = { type: defEffectType };
          }

          if (syntheticEffect) {
            // Default matches are given priority -1 so explicit rules always win
            const dm: Match = { policyKey, ruleId: "__default__", priority: -1, effect: syntheticEffect };
            if (defEffectType === "kill_switch") {
              kills.push(dm);
              if (wantTrace) traceBase!.summary.considered.kill_switch += 1;
            } else if (defEffectType === "deny") {
              denies.push(dm);
              if (wantTrace) traceBase!.summary.considered.deny += 1;
            } else if (defEffectType === "throttle") {
              throttles.push(dm);
              if (wantTrace) traceBase!.summary.considered.throttle += 1;
            } else if (defEffectType === "allow") {
              allows.push(dm);
              if (wantTrace) traceBase!.summary.considered.allow += 1;
            } else if (defEffectType === "custom") {
              customs.push(dm);
              if (wantTrace) traceBase!.summary.considered.custom += 1;
            }
          }
        }
      }
    }

    // Precedence: kill_switch > deny > throttle(strictest) > allow > custom > deny-by-default
    if (kills.length) {
      const w = kills.sort(byRuleOrder)[0]!;
      const isDefault = w.ruleId === "__default__";
      const decision: Decision = {
        decision: "kill_switch",
        reason: isDefault ? "default" : "rule",
        policyKey: w.policyKey,
        ruleId: isDefault ? undefined : w.ruleId,
        killSwitch: w.effect.killSwitch,
      };

      if (!wantTrace) return decision;
      return {
        ...decision,
        trace: {
          ...traceBase!,
          winner: { policyKey: w.policyKey, ruleId: w.ruleId, effectType: "kill_switch", priority: w.priority },
        },
      };
    }

    if (denies.length) {
      const w = denies.sort(byRuleOrder)[0]!;
      const isDefault = w.ruleId === "__default__";
      const decision: Decision = {
        decision: "deny",
        reason: isDefault ? "default" : "rule",
        policyKey: w.policyKey,
        ruleId: isDefault ? undefined : w.ruleId,
      };

      if (!wantTrace) return decision;
      return {
        ...decision,
        trace: {
          ...traceBase!,
          winner: { policyKey: w.policyKey, ruleId: w.ruleId, effectType: "deny", priority: w.priority },
        },
      };
    }

    if (throttles.length) {
      const w = throttles
        .sort((a, b) => {
          const A = throttleStrictness(a.effect.throttle);
          const B = throttleStrictness(b.effect.throttle);

          // lower rate => stricter
          if (A.rate !== B.rate) return A.rate - B.rate;
          if (A.limit !== B.limit) return A.limit - B.limit;
          if (A.windowSeconds !== B.windowSeconds) return A.windowSeconds - B.windowSeconds;
          return byRuleOrder(a, b);
        })[0]!;

      const isDefault = w.ruleId === "__default__";
      const decision: Decision = {
        decision: "throttle",
        reason: isDefault ? "default" : "rule",
        policyKey: w.policyKey,
        ruleId: isDefault ? undefined : w.ruleId,
        throttle: w.effect.throttle,
      };

      if (!wantTrace) return decision;
      return {
        ...decision,
        trace: {
          ...traceBase!,
          winner: { policyKey: w.policyKey, ruleId: w.ruleId, effectType: "throttle", priority: w.priority },
        },
      };
    }

    if (allows.length) {
      const w = allows.sort(byRuleOrder)[0]!;
      const isDefault = w.ruleId === "__default__";
      const decision: Decision = {
        decision: "allow",
        reason: isDefault ? "default" : "rule",
        policyKey: w.policyKey,
        ruleId: isDefault ? undefined : w.ruleId,
      };

      if (!wantTrace) return decision;
      return {
        ...decision,
        trace: {
          ...traceBase!,
          winner: { policyKey: w.policyKey, ruleId: w.ruleId, effectType: "allow", priority: w.priority },
        },
      };
    }

    // custom: lower precedence than allow, higher than deny-by-default
    if (customs.length) {
      const w = customs.sort(byRuleOrder)[0]!;
      const isDefault = w.ruleId === "__default__";
      const rawValue = String(w.effect.value ?? "");
      let parsedValue: unknown;
      if (opts.parseCustomEffect) {
        try { parsedValue = JSON.parse(rawValue); } catch { /* invalid JSON – leave undefined */ }
      }
      const decision: Decision = {
        decision: "custom",
        reason: isDefault ? "default" : "rule",
        policyKey: w.policyKey,
        ruleId: isDefault ? undefined : w.ruleId,
        value: rawValue,
        ...(parsedValue !== undefined ? { parsedValue } : {}),
      };

      if (!wantTrace) return decision;
      return {
        ...decision,
        trace: {
          ...traceBase!,
          winner: { policyKey: w.policyKey, ruleId: w.ruleId, effectType: "custom", priority: w.priority },
        },
      };
    }

    const decision: Decision = { decision: "deny", reason: "default" };
    if (!wantTrace) return decision;

    return {
      ...decision,
      trace: {
        ...traceBase!,
        winner: undefined,
      },
    };
  }

  return {
    evaluate(input: EvaluateInput) {
      return coreEvaluate(input, false);
    },

    evaluateWithTrace(input: EvaluateInput, options?: TraceOptions): DecisionWithOptionalTrace {
        const merged: TraceOptions = {
          ...(opts.traceDefaults ?? {}),
          ...(options ?? {}),
        };

        const level = (merged.level ?? "sampled") as any;
        const sampling = clamp01(merged.sampling ?? 0.01);
        const force = merged.force === true;

        const isOff = level === "off";
        const isErrorLevel = level === "errors";
        const isFull = level === "full";
        const isSampled = level === "sampled";

        if (isOff) {
          return coreEvaluate(input, false);
        }

        // Always compute decision first (no trace)
        const baseDecision: any = coreEvaluate(input, false);

        // errors: only trace on deny/kill_switch unless force
        if (isErrorLevel) {
          const isErrDecision = baseDecision.decision === "deny" || baseDecision.decision === "kill_switch";
          if (!isErrDecision && !force) {
            return baseDecision;
          }

          if (!force) {
            const ok = budget.allow();
            if (!ok) return baseDecision;
          }

          const out: any = coreEvaluate(input, true);
          if (out?.trace) out.trace.sampled = force ? "forced" : "errors";

          // errors => compact by default
          const { rules: discardedRules, ...compact } = out.trace ?? {};
          const finalOut = { ...out, trace: compact };

          emitTraceIfAny({ level: "errors", decision: out, trace: out.trace, sink: opts.traceSink, dispatcher, onSinkError: opts.onTraceSinkError });

          return finalOut;
        }

        // full: always trace (budget unless forced)
        if (isFull) {
          if (!force) {
            const ok = budget.allow();
            if (!ok) return baseDecision;
          }

          const out: any = coreEvaluate(input, true);
          if (out?.trace) out.trace.sampled = force ? "forced" : "random";

          emitTraceIfAny({ level: "full", decision: out, trace: out.trace, sink: opts.traceSink, dispatcher, onSinkError: opts.onTraceSinkError });

          return out;
        }

        // sampled: sampling + budget (compact)
        if (isSampled) {
          const include = force ? true : Math.random() < sampling;
          if (!include) return baseDecision;

          if (!force) {
            const ok = budget.allow();
            if (!ok) return baseDecision;
          }

          const out: any = coreEvaluate(input, true);
          if (out?.trace) out.trace.sampled = force ? "forced" : "random";

          const { rules: discardedRules, ...compact } = out.trace ?? {};
          const finalOut = { ...out, trace: compact };

          emitTraceIfAny({ level: "sampled", decision: out, trace: out.trace, sink: opts.traceSink, dispatcher, onSinkError: opts.onTraceSinkError });

          return finalOut;
        }

        // fallback: no trace
        return baseDecision;
      },
      flushTraces: async () => {
        if (!dispatcher) return;
        await dispatcher.flush();
      },
  };
}