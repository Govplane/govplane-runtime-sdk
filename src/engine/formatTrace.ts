import type {
  DecisionTraceCompact,
  DecisionTraceFull,
} from "./types.js";

interface FormatOpts {
  multiline?: boolean;   // default: false
  includeDiscarded?: boolean; // only for full traces
}

export function formatTrace(
  trace: DecisionTraceCompact | DecisionTraceFull,
  opts: FormatOpts = {},
): string {
  const lines: string[] = [];

  const hdr =
    `[govplane] traceId=${trace.traceId} ` +
    `sampled=${trace.sampled} ` +
    `policies=${trace.summary.policiesSeen} ` +
    `rules=${trace.summary.rulesSeen} ` +
    `matched=${trace.summary.matched}`;

  lines.push(hdr);

  if (trace.winner) {
    lines.push(
      `winner → policy=${trace.winner.policyKey} ` +
      `rule=${trace.winner.ruleId} ` +
      `effect=${trace.winner.effectType} ` +
      `priority=${trace.winner.priority}`,
    );
  } else {
    lines.push(`winner → none (default decision)`);
  }

  if ("rules" in trace && opts.includeDiscarded) {
    const discarded = trace.rules.filter(r => !r.matched);

    if (discarded.length) {
      lines.push(`discarded rules:`);

      for (const r of discarded) {
        lines.push(
          `- policy=${r.policyKey} ` +
          `rule=${r.ruleId} ` +
          `effect=${r.effectType ?? "?"} ` +
          `reason=${r.discardedReason}`,
        );
      }
    }
  }

  if (opts.multiline) {
    return lines.join("\n");
  }

  return lines.join(" | ");
}