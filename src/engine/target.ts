import type { Target } from './types.js';

/**
 * Target matching, in one place.
 *
 * `targetMatch` is the engine's own rule: a rule aims at a target when all
 * three fields agree exactly. `targetMatchesScope` is the looser form the
 * required-signals feature needs — a scope names only the fields it cares
 * about, and an omitted field means "any". Keeping both here rather than
 * letting the second grow its own comparison is what stops the two from
 * quietly disagreeing about what a match is.
 */

export const targetMatch = (a: Target, b: Target): boolean => (
  a.service === b.service && a.resource === b.resource && a.action === b.action
);

export const targetMatchesScope = (scope: Partial<Target>, target: Target): boolean => (
  (scope.service === undefined || scope.service === target.service)
  && (scope.resource === undefined || scope.resource === target.resource)
  && (scope.action === undefined || scope.action === target.action)
);
