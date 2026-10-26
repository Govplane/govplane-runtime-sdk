import { ConfigurationError } from '../errors/errors.js';
import { targetMatchesScope } from './target.js';
import type { Decision, Target } from './types.js';

/**
 * Required signals.
 *
 * A signal is a context key whose value came from a probabilistic process — a
 * classifier score, a detector verdict, a confidence. Nothing about the key
 * itself is special, and the engine does not try to make it so. What this
 * module adds is the ability to *declare a dependency* on one, and to say what
 * happens when the dependency is not met.
 *
 * Without a declaration, a missing `piiScore` is not an error: the numeric
 * operators compare `NaN`, every comparison is false, the rule that would have
 * denied simply does not match, and the request proceeds. That is a fail-open
 * path nobody chose. A declaration turns it into a decision the policy author
 * made on purpose.
 */

export type SignalsOnMissing = 'deny' | 'kill_switch' | 'allow' | 'throw';

export interface RequiredSignal {
  /** The context key that must be present as a finite number. */
  signal: string;
  /**
   * Which targets the requirement applies to. Fields omitted mean "any", so an
   * empty or absent `when` applies everywhere.
   */
  when?: Partial<Target>;
}

export interface SignalsConfig {
  /** A bare string is shorthand for `{ signal }` with no scope. */
  required: (string | RequiredSignal)[];
  /** What evaluation returns when a requirement is not met. Defaults to `deny`. */
  onMissing?: SignalsOnMissing;
}

export interface NormalizedSignals {
  required: RequiredSignal[];
  onMissing: SignalsOnMissing;
}

const ON_MISSING = new Set<string>(['deny', 'kill_switch', 'allow', 'throw']);
const SCOPE_FIELDS = new Set<string>(['service', 'resource', 'action']);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim() !== ''
);

const invalid = (message: string, path: string): ConfigurationError => new ConfigurationError(
  `engine.signals${path}: ${message}`,
  'INVALID_CONFIGURATION',
  { path: `engine.signals${path}` },
);

const normalizeScope = (when: unknown, path: string): Partial<Target> | undefined => {
  if (when === undefined) return undefined;
  if (typeof when !== 'object' || when === null || Array.isArray(when)) {
    throw invalid('when must be an object.', path);
  }
  const scope: Partial<Target> = {};
  for (const [field, value] of Object.entries(when)) {
    if (!SCOPE_FIELDS.has(field)) {
      throw invalid(`unknown field "${field}"; a scope names service, resource or action.`, path);
    }
    if (!isNonEmptyString(value)) {
      throw invalid(`${field} must be a non-empty string.`, path);
    }
    scope[field as keyof Target] = value;
  }
  return scope;
};

/**
 * Validates a signals block once, at construction.
 *
 * Every problem is an `INVALID_CONFIGURATION` naming the path, because a
 * declaration that was silently ignored would leave exactly the fail-open
 * path the declaration exists to close.
 */
export const normalizeSignals = (config: unknown): NormalizedSignals => {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw invalid('must be an object.', '');
  }
  const { required, onMissing } = config as Record<string, unknown>;

  if (!Array.isArray(required) || required.length === 0) {
    throw invalid('required must be a non-empty array.', '.required');
  }

  const normalized: RequiredSignal[] = required.map((entry, index) => {
    const path = `.required[${index}]`;
    if (isNonEmptyString(entry)) return { signal: entry };
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid('must be a signal name or { signal, when? }.', path);
    }
    const { signal, when } = entry as Record<string, unknown>;
    if (!isNonEmptyString(signal)) {
      throw invalid('signal must be a non-empty string.', `${path}.signal`);
    }
    const scope = normalizeScope(when, `${path}.when`);
    return scope === undefined ? { signal } : { signal, when: scope };
  });

  if (onMissing !== undefined && (typeof onMissing !== 'string' || !ON_MISSING.has(onMissing))) {
    throw invalid('onMissing must be one of deny, kill_switch, allow or throw.', '.onMissing');
  }

  return { required: normalized, onMissing: (onMissing as SignalsOnMissing | undefined) ?? 'deny' };
};

/**
 * Whether a supplied value counts as a signal.
 *
 * A finite number, and nothing else. `0` is a perfectly good score and must not
 * be read as absence; `NaN`, `Infinity`, `null` and `'0.87'` are all things a
 * broken detector might hand over, and none of them can be compared honestly.
 */
export const isSignalPresent = (value: unknown): boolean => (
  typeof value === 'number' && Number.isFinite(value)
);

/**
 * The names of every required signal that is missing for this target, in
 * declaration order and without repeats.
 */
export const findMissingSignals = (
  signals: NormalizedSignals,
  target: Target,
  ctx: Record<string, unknown>,
): string[] => {
  const missing: string[] = [];
  for (const requirement of signals.required) {
    if (requirement.when !== undefined && !targetMatchesScope(requirement.when, target)) continue;
    if (isSignalPresent(ctx[requirement.signal])) continue;
    if (!missing.includes(requirement.signal)) missing.push(requirement.signal);
  }
  return missing;
};

/** The names declared, deduplicated, for `status()`. */
export const declaredSignalNames = (signals: NormalizedSignals): string[] => {
  const names: string[] = [];
  for (const requirement of signals.required) {
    if (!names.includes(requirement.signal)) names.push(requirement.signal);
  }
  return names;
};

/**
 * The decision returned in place of an evaluation, for the three non-throwing
 * modes. The `throw` mode is handled by the caller, which has the error class.
 */
export const signalMissingDecision = (
  onMissing: Exclude<SignalsOnMissing, 'throw'>,
  missingSignals: string[],
  target: Target,
): Decision => {
  if (onMissing === 'kill_switch') {
    return {
      decision: 'kill_switch',
      reason: 'signal_missing',
      killSwitch: { service: target.service, reason: 'signal_missing' },
      missingSignals,
    };
  }
  return { decision: onMissing, reason: 'signal_missing', missingSignals };
};
