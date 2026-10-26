import { DEFAULT_CONTEXT_POLICY, looksLikePiiKey } from '../engine/context.js';
import type { ContextPolicy } from '../engine/context.js';
import { ConfigurationError } from '../errors/errors.js';
import type { Decision } from '../engine/types.js';
import type { ResolvedRecordConfig } from './types.js';

/**
 * Validation of the `record` block, at construction.
 *
 * The privacy rule in the RFC is the one that matters: no context value is
 * recorded unless its key is named, and a key that looks like personal data
 * cannot be named while a context policy that blocks such keys is in force.
 * That is an error on line one of the application, not a warning in a log
 * nobody reads.
 */

const DEFAULT_MAX_RECORDS = 100;
const DEFAULT_MAX_DELAY_MS = 1000;
const DEFAULT_QUEUE_FACTOR = 4;

const DECISIONS = new Set<string>([
  'allow', 'deny', 'kill_switch', 'requires_approval', 'throttle', 'custom',
]);
const OVERFLOW = new Set<string>(['drop-oldest', 'drop-newest', 'block-never']);

/** The decisions nobody regrets having recorded. */
export const DEFAULT_ALWAYS: Decision['decision'][] = ['deny', 'kill_switch', 'requires_approval'];

const invalid = (message: string, path: string, details: Record<string, unknown> = {}) => (
  new ConfigurationError(`record${path}: ${message}`, 'INVALID_CONFIGURATION', {
    path: `record${path}`,
    ...details,
  })
);

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readInteger = (value: unknown, min: number, path: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalid(`must be an integer of ${min} or more.`, path);
  }
  return value;
};

/**
 * Context validation is enforced by the client exactly when a policy is
 * configured, unless `validateContext` says otherwise — the same rule
 * `createClient` applies. The PII check on `include.context` follows it: it
 * would be strange to refuse a key here that `evaluate()` accepts, or accept
 * one that `evaluate()` refuses.
 */
export interface ContextEnforcement {
  validateContext?: boolean | undefined;
  contextPolicy?: ContextPolicy | undefined;
}

const piiBlocked = (engine: ContextEnforcement | undefined): boolean => {
  const enforced = engine?.validateContext ?? engine?.contextPolicy !== undefined;
  if (!enforced) return false;
  const policy = engine?.contextPolicy ?? DEFAULT_CONTEXT_POLICY;
  return policy.blockLikelyPiiKeys ?? true;
};

export const validateRecordConfig = (
  config: unknown,
  engine?: ContextEnforcement,
): ResolvedRecordConfig => {
  if (!isObject(config)) throw invalid('must be an object.', '');

  const {
    sink, include, batch, maxQueue, overflow, chain, sample,
  } = config;

  if (typeof sink !== 'function') throw invalid('sink must be a function.', '.sink');

  const includeContext: string[] = [];
  if (include !== undefined) {
    if (!isObject(include)) throw invalid('must be an object.', '.include');
    if (include.context !== undefined) {
      if (!Array.isArray(include.context)) {
        throw invalid('must be an array of context keys.', '.include.context');
      }
      const blocked = piiBlocked(engine);
      include.context.forEach((key, index) => {
        const path = `.include.context[${index}]`;
        if (typeof key !== 'string' || key.trim() === '') {
          throw invalid('must be a non-empty string.', path);
        }
        if (includeContext.includes(key)) throw invalid(`"${key}" is listed twice.`, path);
        if (blocked && looksLikePiiKey(key)) {
          throw invalid(
            `"${key}" looks like personal data and engine.contextPolicy.blockLikelyPiiKeys is on. `
            + 'Recording it into an audit log is refused; drop the key or turn the heuristic off '
            + 'deliberately.',
            path,
            { key },
          );
        }
        includeContext.push(key);
      });
    }
  }

  if (batch !== undefined && !isObject(batch)) throw invalid('must be an object.', '.batch');
  const maxRecords = readInteger(batch?.maxRecords, 1, '.batch.maxRecords', DEFAULT_MAX_RECORDS);
  const maxDelayMs = readInteger(batch?.maxDelayMs, 0, '.batch.maxDelayMs', DEFAULT_MAX_DELAY_MS);
  const queue = readInteger(maxQueue, 1, '.maxQueue', maxRecords * DEFAULT_QUEUE_FACTOR);
  if (queue < maxRecords) {
    throw invalid(`must be at least batch.maxRecords (${maxRecords}).`, '.maxQueue');
  }

  if (overflow !== undefined && (typeof overflow !== 'string' || !OVERFLOW.has(overflow))) {
    throw invalid('must be drop-oldest, drop-newest or block-never.', '.overflow');
  }
  if (chain !== undefined && typeof chain !== 'boolean') {
    throw invalid('must be a boolean.', '.chain');
  }

  let sampleRate = 1;
  let always: Decision['decision'][] = DEFAULT_ALWAYS;
  if (sample !== undefined) {
    if (!isObject(sample)) throw invalid('must be an object.', '.sample');
    if (sample.rate !== undefined) {
      if (typeof sample.rate !== 'number' || !(sample.rate >= 0 && sample.rate <= 1)) {
        throw invalid('must be a number between 0 and 1.', '.sample.rate');
      }
      sampleRate = sample.rate;
    }
    if (sample.always !== undefined) {
      if (!Array.isArray(sample.always)) throw invalid('must be an array.', '.sample.always');
      sample.always.forEach((entry, index) => {
        if (typeof entry !== 'string' || !DECISIONS.has(entry)) {
          throw invalid('must be a decision name.', `.sample.always[${index}]`);
        }
      });
      always = sample.always as Decision['decision'][];
    }
  }

  return {
    sink: sink as ResolvedRecordConfig['sink'],
    includeContext,
    maxRecords,
    maxDelayMs,
    maxQueue: queue,
    overflow: overflow === 'drop-newest' ? 'drop-newest' : 'drop-oldest',
    chain: chain === true,
    sampleRate,
    always: new Set(always),
  };
};
