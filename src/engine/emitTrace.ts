import type { Decision } from "./types.js";
import type {
  DecisionTraceCompact,
  DecisionTraceFull,
  StructuredTraceEvent,
  TraceLevel,
  TraceSink,
} from "./types.js";
import { toStructuredTraceEvent } from "./toStructuredTrace.js";
import type { TraceDispatcher } from "./traceDispatcher.js";

export function emitTraceIfAny(input: {
  level: TraceLevel;
  decision: Decision;
  trace?: DecisionTraceCompact | DecisionTraceFull;

  sink?: TraceSink;
  dispatcher?: TraceDispatcher;

  onSinkError?: (err: unknown) => void;
}): void {
  const { trace, decision, level } = input;
  if (!trace) return;

  let evt: StructuredTraceEvent;
  try {
    evt = toStructuredTraceEvent({ level, decision, trace });
  } catch (err) {
    input.onSinkError?.(err);
    return;
  }

  // Sync sink (best-effort)
  if (input.sink) {
    try {
      input.sink(evt);
    } catch (err) {
      input.onSinkError?.(err);
    }
  }

  // Async sink via dispatcher (non-blocking)
  if (input.dispatcher) {
    input.dispatcher.enqueue(evt);
  }
}