import type { Decision } from "./types.js";
import type { DecisionTraceCompact, DecisionTraceFull, StructuredTraceEvent, TraceLevel } from "./types.js";

export function toStructuredTraceEvent(input: {
  level: TraceLevel;
  decision: Decision;
  trace: DecisionTraceCompact | DecisionTraceFull;
}): StructuredTraceEvent {
  const { decision, trace, level } = input;

  const evt: StructuredTraceEvent = {
    v: 1,
    ts: trace.evaluatedAt,
    traceId: trace.traceId,
    sampled: trace.sampled,
    level,
    target: trace.target,
    decision: decision.decision,
    reason: decision.reason,
    winner: trace.winner,
    summary: trace.summary,
  };

  if (level === "full" && "rules" in trace) {
    evt.rules = trace.rules.map(r => ({
      policyKey: r.policyKey,
      ruleId: r.ruleId,
      priority: r.priority,
      effectType: r.effectType,
      matched: r.matched,
      discardedReason: r.discardedReason,
    }));
  }

  return evt;
}