import { randomUUID } from "node:crypto";
import type {
  Decision, RuntimeBundleV1, Target, PolicyEngine, PolicyEngineEvaluateInput, EvaluateOptions,
} from "./types.js";
import { isRuleInput } from "./types.js";
import { shapeDecision } from "./decisionShape.js";
import { RuleNotFoundError, SignalMissingError } from "../errors/errors.js";
import type { ContextPolicy } from "./context.js";
import { targetMatch } from "./target.js";
import type { SignalsConfig, NormalizedSignals } from "./signals.js";
import { normalizeSignals, findMissingSignals, signalMissingDecision } from "./signals.js";
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
   * Called with every decision, unsampled, before any output shaping.
   *
   * The companion to `traceSink`, and deliberately a different thing. A trace
   * carries full detail and is therefore sampled and budgeted, which makes it
   * useless for counting: `evaluate()` emits none at all, and
   * `evaluateWithTrace()` emits 1% of them by default. This hook fires on every
   * evaluation through either method and receives the decision before
   * `shapeDecision` reduces it to a boolean or a bare effect, so `policyKey`
   * and `ruleId` are still present.
   *
   * It runs on the hot path. Keep it to a counter increment, and note that
   * anything thrown here is swallowed rather than allowed to fail the
   * evaluation.
   */
  onDecision?: (decision: Decision) => void;

  /**
   * When true, custom effect `value` strings are JSON-parsed and the result
   * is attached as `parsedValue` on the decision.  Parsing errors are
   * silently swallowed and `parsedValue` is left undefined.
   */
  parseCustomEffect?: boolean;

  /**
   * Context keys the policies depend on, and what to do when one is missing.
   *
   * Validated once here; a malformed block is an `INVALID_CONFIGURATION` at
   * construction rather than a requirement that quietly never applied.
   */
  signals?: SignalsConfig;
}

type EvaluateInput = PolicyEngineEvaluateInput;

/**
 * The address of a rule named directly by the caller.
 *
 * Resolving it up front turns "evaluate this rule" into "evaluate the bundle,
 * looking only here", so the rule then travels the same path a target-selected
 * rule does — same status check, same `when`, same policy default, same
 * decision construction. Answering by rule id and by target therefore cannot
 * disagree, because there is only one implementation to disagree with.
 */
interface RuleSelection {
  policyKey: string;
  ruleId: string;
  /**
   * The selected rule's own target, carried so traces stay well-formed.
   *
   * A rule-addressed evaluation has no requested target, but `trace.target` is
   * required by the published trace types and reading it is how a trace says
   * what was evaluated. Recording what the rule covers is both true and useful;
   * widening the field to optional would break every consumer already reading
   * it, for a minor release.
   */
  target: Target;
}

const NO_TARGET: Target = { service: "", resource: "", action: "" };

/** The synthetic id the engine gives policy defaults; never a real rule. */
const DEFAULT_RULE_ID = "__default__";

function resolveRuleSelection(
  bundle: RuntimeBundleV1,
  input: Extract<PolicyEngineEvaluateInput, { ruleId: string }>,
): RuleSelection {
  const { ruleId } = input;

  if (ruleId === DEFAULT_RULE_ID) {
    throw new RuleNotFoundError(
      `"${DEFAULT_RULE_ID}" is the engine's marker for a policy default, not a rule that can be evaluated.`,
      { ruleId },
    );
  }

  const policies: any[] = (bundle as any).policies ?? [];

  if (input.policyKey !== undefined) {
    const policy = policies.find((p) => String(p?.policyKey ?? "") === input.policyKey);
    if (!policy) {
      throw new RuleNotFoundError(
        `No policy "${input.policyKey}" in this bundle.`,
        { policyKey: input.policyKey, ruleId },
      );
    }
    const rule = (policy.rules ?? []).find((r: any) => String(r?.id ?? "") === ruleId);
    if (!rule) {
      throw new RuleNotFoundError(
        `Policy "${input.policyKey}" has no rule "${ruleId}".`,
        { policyKey: input.policyKey, ruleId },
      );
    }
    return { policyKey: input.policyKey, ruleId, target: rule.target ?? NO_TARGET };
  }

  // No policy given: first match in bundle order. Rule ids are only unique
  // within a policy — the validator's duplicate check resets per policy — so
  // this is a genuine choice between candidates, and bundle order is the one
  // that stays stable for a given bundle.
  for (const policy of policies) {
    const rule = (policy?.rules ?? []).find((r: any) => String(r?.id ?? "") === ruleId);
    if (rule) {
      return {
        policyKey: String(policy?.policyKey ?? ""),
        ruleId,
        target: rule.target ?? NO_TARGET,
      };
    }
  }

  throw new RuleNotFoundError(`No rule "${ruleId}" in this bundle.`, { ruleId });
}

interface Match {
  policyKey: string;
  ruleId: string;
  priority: number;
  effect: any;
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

  const signals: NormalizedSignals | undefined = opts.signals === undefined
    ? undefined
    : normalizeSignals(opts.signals);

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
          // Filled in below for a rule-addressed evaluation, once the rule has
          // been resolved and its own target is known.
          target: isRuleInput(input) ? NO_TARGET : input.target,
          summary: {
            policiesSeen: 0,
            rulesSeen: 0,
            matched: 0,
            considered: { kill_switch: 0, deny: 0, requires_approval: 0, throttle: 0, allow: 0, custom: 0 },
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

    // Addressing a rule by name narrows the search to it; addressing a target
    // leaves the search open and lets target matching do the narrowing. The
    // resolution throws when the rule is not there, which is the one evaluation
    // input the engine refuses to answer with a denial.
    const selection: RuleSelection | null = isRuleInput(input)
      ? resolveRuleSelection(bundle, input)
      : null;
    const target: Target | null = isRuleInput(input) ? null : input.target;

    if (selection !== null && wantTrace) {
      traceBase!.target = selection.target;
    }

    // Required signals are checked here and not earlier, on purpose. Later
    // than the missing-bundle denial, so that `onMissing: 'allow'` can never
    // turn "no bundle" into a permission. Later than rule resolution, so that a
    // requirement scoped to a service gates a rule whether it was addressed by
    // target or by name — otherwise naming the rule would be a way around it.
    // And before any policy is consulted, because the whole point is that a
    // policy which depends on a signal it did not receive has no answer to give.
    if (signals !== undefined) {
      const effectiveTarget = selection !== null ? selection.target : target!;
      const missing = findMissingSignals(signals, effectiveTarget, ctx);
      if (missing.length) {
        if (signals.onMissing === "throw") {
          throw new SignalMissingError(
            `Required signal${missing.length === 1 ? "" : "s"} missing: ${missing.join(", ")}.`,
            { missingSignals: missing, target: effectiveTarget },
          );
        }
        const decision = signalMissingDecision(signals.onMissing, missing, effectiveTarget);
        if (!wantTrace) return decision;
        // No rule was consulted, so the summary stays at zero and there is no
        // winner: the trace says truthfully that the bundle was never asked.
        return { ...decision, trace: { ...traceBase!, winner: undefined } };
      }
    }

    const kills: Match[] = [];
    const denies: Match[] = [];
    const approvals: Match[] = [];
    const throttles: Match[] = [];
    const allows: Match[] = [];
    const customs: Match[] = [];

    const policies = bundle.policies ?? [];
    if (wantTrace) traceBase!.summary.policiesSeen = policies.length;

    for (const p of policies) {
      const policyKey = String((p as any).policyKey ?? "");
      const rules = (p as any).rules ?? [];

      // A named rule lives in exactly one policy. Skipping the rest here rather
      // than discarding them later keeps them out of the trace as well: they
      // were never candidates, so reporting them as rejected would be noise.
      if (selection !== null && policyKey !== selection.policyKey) {
        continue;
      }

      // Track whether any rule in this policy produced a match for this target
      let policyHadMatch = false;

      // Whether this policy governs the target at all: at least one active rule
      // aims at it, however that rule's condition then resolved. A policy about
      // refunds has nothing to say about a login, and its default must not be
      // read as an opinion on one.
      let policyGovernsTarget = false;

      for (const r of rules) {
        const ruleId = String(r?.id ?? "");

        if (selection !== null && ruleId !== selection.ruleId) {
          continue;
        }

        if (wantTrace) traceBase!.summary.rulesSeen += 1;

        const priority = Number(r?.priority ?? 0);

        // Scope is what the policy is *about*, so it is read before anything
        // that can discard a rule. A rule aimed here still places the policy in
        // scope while switched off: otherwise disabling one rule would swap the
        // policy's own default for the global deny-by-default, silently denying
        // everything that rule covered — far more than turning a rule off should
        // ever mean.
        // A rule named directly is in scope by definition: the caller asked for
        // this rule, so its policy is the one being consulted and its default is
        // the one that stands in if the rule does not fire.
        if (selection !== null || (r?.target && target && targetMatch(r.target, target))) {
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

        // Target mismatch. Skipped when the rule was named: the caller addressed
        // it directly, so what it happens to target says what it is about, not
        // whether it was selected.
        if (selection === null && (!r?.target || !target || !targetMatch(r.target, target))) {
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
        } else if (effectType === "requires_approval") {
          approvals.push(m);
          if (wantTrace) traceBase!.summary.considered.requires_approval += 1;
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
          } else if (defEffectType === "requires_approval") {
            // The descriptor is optional on a default; anything that is not an
            // object is dropped rather than passed through as a surprise.
            const { approval } = defaults;
            syntheticEffect = approval && typeof approval === "object" && !Array.isArray(approval)
              ? { type: "requires_approval", approval }
              : { type: "requires_approval" };
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
            } else if (defEffectType === "requires_approval") {
              approvals.push(dm);
              if (wantTrace) traceBase!.summary.considered.requires_approval += 1;
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

    // Precedence: kill_switch > deny > requires_approval > throttle(strictest) > allow > custom > deny-by-default
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

    // requires_approval sits just below deny: an outright refusal still wins,
    // but a gate outranks any rule that would have let the action proceed,
    // throttled or not. An action that needs a human must never slip through
    // because another rule was merely permissive.
    if (approvals.length) {
      const w = approvals.sort(byRuleOrder)[0]!;
      const isDefault = w.ruleId === "__default__";
      const decision: Decision = {
        decision: "requires_approval",
        reason: isDefault ? "default" : "rule",
        policyKey: w.policyKey,
        ruleId: isDefault ? undefined : w.ruleId,
        ...(w.effect.approval === undefined ? {} : { approval: w.effect.approval }),
      };

      if (!wantTrace) return decision;
      return {
        ...decision,
        trace: {
          ...traceBase!,
          winner: { policyKey: w.policyKey, ruleId: w.ruleId, effectType: "requires_approval", priority: w.priority },
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

  /** The original `evaluateWithTrace` body, unchanged. */
  const evaluateWithTraceInner = (input: EvaluateInput, options?: TraceOptions): DecisionWithOptionalTrace => {
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
      };

  /**
   * Fires the decision hook without letting it affect the decision.
   *
   * A counter in a telemetry module has no business failing an authorization
   * call, so a throw here is swallowed the same way a trace sink's is.
   */
  const notifyDecision = (decision: Decision): void => {
    if (!opts.onDecision) return;
    try {
      opts.onDecision(decision);
    } catch (err) {
      opts.onTraceSinkError?.(err);
    }
  };

  return {
    // Asserted rather than inferred: an object-literal method cannot carry the
    // overload list that makes the return type follow the option, so the
    // signature is declared once on `PolicyEngine` and this implementation is
    // checked against its widest form.
    evaluate: ((input: EvaluateInput, options?: EvaluateOptions) => {
      const decision = coreEvaluate(input, false);
      notifyDecision(decision);
      return shapeDecision(decision, options);
    }) as PolicyEngine["evaluate"],

    evaluateWithTrace(input: EvaluateInput, options?: TraceOptions): DecisionWithOptionalTrace {
      // Wrapped so the hook fires exactly once regardless of which branch the
      // trace level takes, and whether a trace was emitted at all. Counting must
      // not inherit tracing's sampling.
      const traced = evaluateWithTraceInner(input, options);
      notifyDecision(traced);
      return traced;
    },


      flushTraces: async () => {
        if (!dispatcher) return;
        await dispatcher.flush();
      },
  };
}