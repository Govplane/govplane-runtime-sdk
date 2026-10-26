import { ConfigurationError } from '../errors/errors.js';
import type { Decision, EvaluateOptions } from './types.js';

/**
 * Reducing a decision to a boolean, a bit, or its effect name.
 *
 * The mapping lives here rather than at each call site so the two entry points
 * cannot drift, and so the one judgement it encodes is written down once.
 *
 * That judgement is about `throttle` and `requires_approval`. `allow` and
 * `custom` are permissions; `deny` and `kill_switch` are plainly not. A throttle
 * sits between them: the action is permitted, but only within a limit that a
 * boolean cannot carry. A caller who reduced it to `true` would proceed while
 * silently discarding the rate limit — so it reduces to `false`, and anything
 * that needs the limit reads the full decision instead. `requires_approval` is
 * the same shape of answer: permitted only once a human has acted, which a
 * boolean cannot express either, so it too is `false` until the host says
 * otherwise.
 */

const PERMISSIVE = new Set<Decision['decision']>(['allow', 'custom']);

/** Whether a decision permits the action, with no detail about the terms. */
export const isPermissive = (decision: Decision['decision']): boolean => (
  PERMISSIVE.has(decision)
);

/**
 * Applies whichever return shape the caller asked for.
 *
 * Returns the decision untouched when none was requested, which is the whole of
 * the behaviour before this option existed.
 */
export const shapeDecision = (
  decision: Decision,
  options?: EvaluateOptions,
): Decision | boolean | 0 | 1 | Decision['decision'] => {
  if (options === undefined) {
    return decision;
  }

  const requested = (['asBoolean', 'asBinary', 'effectOnly'] as const)
    .filter((name) => options[name] === true);

  if (requested.length > 1) {
    throw new ConfigurationError(
      `Only one of asBoolean, asBinary or effectOnly may be set; received ${requested.join(', ')}.`,
      'INVALID_EVALUATE_OPTIONS',
      { requested },
    );
  }

  if (options.asBoolean === true) {
    return isPermissive(decision.decision);
  }
  if (options.asBinary === true) {
    return isPermissive(decision.decision) ? 1 : 0;
  }
  if (options.effectOnly === true) {
    return decision.decision;
  }

  return decision;
};
