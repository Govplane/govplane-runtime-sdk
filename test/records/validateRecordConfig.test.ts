import { describe, expect, it } from '@jest/globals';
import { validateRecordConfig } from '../../src/records/validateRecordConfig.js';
import { ConfigurationError } from '../../src/errors/errors.js';

/**
 * The `record` block.
 *
 * The rule that matters is the last one: a key that looks like personal data
 * cannot be named in `include.context` while a context policy that blocks
 * such keys is in force. That is refused at construction, with the key named.
 */

const sink = (): void => {};

type Engine = Parameters<typeof validateRecordConfig>[1];

const failsAt = (config: unknown, path: string, engine?: Engine) => {
  let caught: unknown;
  try {
    validateRecordConfig(config, engine);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigurationError);
  expect((caught as ConfigurationError).code).toBe('INVALID_CONFIGURATION');
  expect((caught as ConfigurationError).details).toMatchObject({ path });
  return caught as ConfigurationError;
};

describe('defaults', () => {
  it('applies the documented defaults', () => {
    expect(validateRecordConfig({ sink })).toEqual({
      sink,
      includeContext: [],
      maxRecords: 100,
      maxDelayMs: 1000,
      maxQueue: 400,
      overflow: 'drop-oldest',
      chain: false,
      sampleRate: 1,
      always: new Set(['deny', 'kill_switch', 'requires_approval']),
    });
  });

  it('derives maxQueue from a custom batch size', () => {
    expect(validateRecordConfig({ sink, batch: { maxRecords: 10 } }).maxQueue).toBe(40);
  });

  it('normalises block-never to drop-oldest', () => {
    expect(validateRecordConfig({ sink, overflow: 'block-never' }).overflow).toBe('drop-oldest');
    expect(validateRecordConfig({ sink, overflow: 'drop-newest' }).overflow).toBe('drop-newest');
  });
});

describe('shape', () => {
  it('requires an object with a sink function', () => {
    failsAt(undefined, 'record');
    failsAt({}, 'record.sink');
    failsAt({ sink: 'log' }, 'record.sink');
  });

  it('checks include.context', () => {
    failsAt({ sink, include: 'context' }, 'record.include');
    failsAt({ sink, include: { context: 'piiScore' } }, 'record.include.context');
    failsAt({ sink, include: { context: [''] } }, 'record.include.context[0]');
    failsAt({ sink, include: { context: ['a', 'a'] } }, 'record.include.context[1]');
  });

  it('checks batch, queue and overflow', () => {
    failsAt({ sink, batch: 5 }, 'record.batch');
    failsAt({ sink, batch: { maxRecords: 0 } }, 'record.batch.maxRecords');
    failsAt({ sink, batch: { maxRecords: 1.5 } }, 'record.batch.maxRecords');
    failsAt({ sink, batch: { maxDelayMs: -1 } }, 'record.batch.maxDelayMs');
    failsAt({ sink, maxQueue: 0 }, 'record.maxQueue');
    failsAt({ sink, batch: { maxRecords: 100 }, maxQueue: 50 }, 'record.maxQueue');
    failsAt({ sink, overflow: 'block' }, 'record.overflow');
    failsAt({ sink, chain: 'yes' }, 'record.chain');
  });

  it('checks sampling', () => {
    failsAt({ sink, sample: 0.5 }, 'record.sample');
    failsAt({ sink, sample: { rate: 2 } }, 'record.sample.rate');
    failsAt({ sink, sample: { rate: Number.NaN } }, 'record.sample.rate');
    failsAt({ sink, sample: { always: 'deny' } }, 'record.sample.always');
    failsAt({ sink, sample: { always: ['maybe'] } }, 'record.sample.always[0]');
    expect(validateRecordConfig({ sink, sample: { rate: 0.05, always: ['deny'] } }))
      .toMatchObject({ sampleRate: 0.05, always: new Set(['deny']) });
  });
});

describe('privacy', () => {
  const policy = { allowedKeys: ['email', 'piiScore'] };

  it('refuses a PII-looking key while a context policy blocks such keys', () => {
    const error = failsAt(
      { sink, include: { context: ['piiScore', 'email'] } },
      'record.include.context[1]',
      { contextPolicy: policy },
    );
    expect(error.details).toMatchObject({ key: 'email' });
    expect(error.message).toContain('email');
  });

  it('follows the client\'s own rule for when the policy is in force', () => {
    const config = { sink, include: { context: ['email'] } };
    // No policy configured: nothing is enforced at evaluate() either.
    expect(validateRecordConfig(config).includeContext).toEqual(['email']);
    // Explicitly on with no policy: the default policy blocks PII keys.
    failsAt(config, 'record.include.context[0]', { validateContext: true });
    // Policy configured but validation switched off: not enforced.
    expect(validateRecordConfig(config, { validateContext: false, contextPolicy: policy })
      .includeContext).toEqual(['email']);
    // Heuristic switched off deliberately: allowed.
    expect(validateRecordConfig(config, {
      contextPolicy: { ...policy, blockLikelyPiiKeys: false },
    }).includeContext).toEqual(['email']);
  });

  it('never accepts a wildcard', () => {
    // '*' is just a key name here, and one nobody's context supplies.
    expect(validateRecordConfig({ sink, include: { context: ['*'] } }).includeContext)
      .toEqual(['*']);
  });
});
