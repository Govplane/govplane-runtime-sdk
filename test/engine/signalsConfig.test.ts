import { describe, expect, it } from '@jest/globals';
import { normalizeSignals } from '../../src/engine/signals.js';
import { ConfigurationError } from '../../src/errors/errors.js';

/**
 * Validation of the signals block.
 *
 * A declaration that is silently ignored leaves exactly the fail-open path a
 * declaration exists to close, so every malformed shape must be an
 * `INVALID_CONFIGURATION` at construction, naming where the problem is.
 */

const failsAt = (config: unknown, path: string): void => {
  let caught: unknown;
  try {
    normalizeSignals(config);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigurationError);
  expect((caught as ConfigurationError).code).toBe('INVALID_CONFIGURATION');
  expect((caught as ConfigurationError).details).toEqual({ path });
};

describe('normalizeSignals', () => {
  it('expands string shorthand and defaults onMissing to deny', () => {
    expect(normalizeSignals({ required: ['piiScore'] })).toEqual({
      required: [{ signal: 'piiScore' }],
      onMissing: 'deny',
    });
  });

  it('keeps a scope only when one was given', () => {
    expect(normalizeSignals({
      required: [{ signal: 'a', when: { service: 's' } }, { signal: 'b' }],
      onMissing: 'throw',
    })).toEqual({
      required: [{ signal: 'a', when: { service: 's' } }, { signal: 'b' }],
      onMissing: 'throw',
    });
  });

  it('rejects a block that is not an object', () => {
    failsAt(null, 'engine.signals');
    failsAt('piiScore', 'engine.signals');
  });

  it('rejects an empty or missing required list', () => {
    failsAt({}, 'engine.signals.required');
    failsAt({ required: [] }, 'engine.signals.required');
    failsAt({ required: 'piiScore' }, 'engine.signals.required');
  });

  it('rejects malformed entries, naming the index', () => {
    failsAt({ required: [''] }, 'engine.signals.required[0]');
    failsAt({ required: ['ok', 42] }, 'engine.signals.required[1]');
    failsAt({ required: [{ when: {} }] }, 'engine.signals.required[0].signal');
  });

  it('rejects malformed scopes', () => {
    failsAt({ required: [{ signal: 'a', when: 'agent' }] }, 'engine.signals.required[0].when');
    failsAt(
      { required: [{ signal: 'a', when: { tenant: 'acme' } }] },
      'engine.signals.required[0].when',
    );
    failsAt(
      { required: [{ signal: 'a', when: { service: '' } }] },
      'engine.signals.required[0].when',
    );
  });

  it('rejects an unknown onMissing', () => {
    failsAt({ required: ['a'], onMissing: 'ignore' }, 'engine.signals.onMissing');
  });
});
