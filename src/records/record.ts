import { isRuleInput } from '../engine/types.js';
import type { Decision, PolicyEngineEvaluateInput } from '../engine/types.js';
import type { BundleSnapshot, DecisionRecord } from './types.js';

/**
 * Building one record from one decision.
 *
 * Pure and cheap: it copies fields and lists key names. Nothing here hashes,
 * allocates beyond the record itself, or reads anything the decision and the
 * input did not already carry — this runs before `evaluate()` returns.
 */

export interface BuildRecordInput {
  decision: Decision;
  input: PolicyEngineEvaluateInput;
  snapshot: BundleSnapshot;
  includeContext: string[];
  seq: number;
  id: string;
  at: string;
}

export const buildDecisionRecord = ({
  decision, input, snapshot, includeContext, seq, id, at,
}: BuildRecordInput): DecisionRecord => {
  const ctx = input.context ?? {};
  const record: DecisionRecord = {
    v: 1,
    id,
    at,
    seq,
    bundle: snapshot,
    decision: decision.decision,
    reason: decision.reason,
    contextKeysPresent: Object.keys(ctx),
  };

  // Assigned rather than spread: this runs inside `evaluate()`, and a chain of
  // conditional spreads costs an allocation per branch.
  if (isRuleInput(input)) {
    record.ruleAddressed = input.policyKey === undefined
      ? { ruleId: input.ruleId }
      : { ruleId: input.ruleId, policyKey: input.policyKey };
  } else {
    record.target = input.target;
  }
  if (decision.policyKey !== undefined) record.policyKey = decision.policyKey;
  if (decision.ruleId !== undefined) record.ruleId = decision.ruleId;
  switch (decision.decision) {
    case 'kill_switch':
      record.killSwitch = decision.killSwitch;
      break;
    case 'throttle':
      record.throttle = decision.throttle;
      break;
    case 'requires_approval':
      if (decision.approval !== undefined) record.approval = decision.approval;
      break;
    case 'custom':
      record.value = decision.value;
      break;
    default:
      break;
  }
  if ('missingSignals' in decision && decision.missingSignals !== undefined) {
    record.missingSignals = decision.missingSignals;
  }

  // Values are copied for named keys only, and only when the key was actually
  // supplied: an absent key is absent from the record too, rather than
  // recorded as `undefined` and then dropped by JSON in a way the reader
  // cannot tell apart from "was never named".
  if (includeContext.length) {
    let context: Record<string, unknown> | undefined;
    for (const key of includeContext) {
      if (Object.prototype.hasOwnProperty.call(ctx, key)) {
        if (context === undefined) context = {};
        context[key] = ctx[key];
      }
    }
    if (context !== undefined) record.context = context;
  }

  return record;
};
