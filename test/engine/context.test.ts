import { describe, expect, it } from '@jest/globals';
import { DEFAULT_CONTEXT_POLICY, validateContext } from '../../src/engine/context.js';
import { formatTrace } from '../../src/engine/formatTrace.js';
import type { DecisionTraceFull } from '../../src/engine/types.js';

/**
 * Context validation and trace formatting.
 *
 * The context policy is the SDK's PII guard. It is only enforced when an
 * application configures one (see `GovplaneClient`), but when it is, these are
 * the rules it applies.
 */

const policy = { allowedKeys: ['plan', 'count', 'flags', 'note'], blockLikelyPiiKeys: false };

describe('validateContext', () => {
  it('accepts an empty context', () => {
    expect(() => validateContext({}, policy)).not.toThrow();
  });

  it('rejects a key outside the allow-list', () => {
    expect(() => validateContext({ unexpected: 1 }, policy))
      .toThrow('Context key not allowed: unexpected');
  });

  it('accepts scalars and skips null and undefined', () => {
    expect(() => validateContext({
      plan: 'pro', count: 7, flags: true, note: null,
    }, policy)).not.toThrow();
    expect(() => validateContext({ note: undefined }, policy)).not.toThrow();
  });

  it('rejects a string longer than the limit', () => {
    expect(() => validateContext({ note: 'x'.repeat(65) }, { ...policy, maxStringLen: 64 }))
      .toThrow('Context value too long: note');
    expect(() => validateContext({ note: 'x'.repeat(64) }, { ...policy, maxStringLen: 64 }))
      .not.toThrow();
  });

  it('rejects an array longer than the limit', () => {
    expect(() => validateContext(
      { flags: ['a', 'b', 'c'] },
      { ...policy, maxArrayLen: 2 },
    )).toThrow('Context array too long: flags');
  });

  it('requires array elements to be strings within the length limit', () => {
    expect(() => validateContext({ flags: [1] }, policy))
      .toThrow('Invalid array value type: flags');
    expect(() => validateContext({ flags: ['x'.repeat(65)] }, { ...policy, maxStringLen: 64 }))
      .toThrow('Invalid array value length: flags');
  });

  it('rejects a value that is neither scalar nor a string array', () => {
    expect(() => validateContext({ plan: { nested: true } }, policy))
      .toThrow('Invalid context type for plan');
  });

  it('blocks keys that look like PII when asked', () => {
    const guarded = { allowedKeys: ['email', 'phone', 'plan'], blockLikelyPiiKeys: true };
    expect(() => validateContext({ email: 'a@b.c' }, guarded))
      .toThrow('Context key looks like PII and is blocked: email');
    expect(() => validateContext({ phone: '123' }, guarded)).toThrow('looks like PII');
    expect(() => validateContext({ plan: 'pro' }, guarded)).not.toThrow();
  });

  it('falls back to its internal defaults for limits it was not given', () => {
    // Only `allowedKeys` is required; the rest are filled in.
    //
    // Note the fallback is *not* DEFAULT_CONTEXT_POLICY. The exported sample
    // policy caps strings at 64, while the internal fallback used for a partial
    // policy caps at 80. Two default sets is an inconsistency inherited from
    // 1.x; this test pins the behaviour as it stands rather than changing the
    // engine, which `govplane simulate` asserts parity against.
    expect(DEFAULT_CONTEXT_POLICY.maxStringLen).toBe(64);

    expect(() => validateContext({ plan: 'x'.repeat(80) }, { allowedKeys: ['plan'] }))
      .not.toThrow();
    expect(() => validateContext({ plan: 'x'.repeat(81) }, { allowedKeys: ['plan'] }))
      .toThrow('Context value too long');
  });
});

describe('formatTrace', () => {
  const trace = (winner: boolean): DecisionTraceFull => ({
    traceId: 't-1',
    sampled: 'forced',
    evaluatedAt: '2026-08-02T00:00:00.000Z',
    target: { service: 'auth', resource: 'login', action: 'authenticate' },
    summary: {
      policiesSeen: 1,
      rulesSeen: 3,
      matched: winner ? 1 : 0,
      considered: {
        kill_switch: 0, deny: 1, throttle: 0, allow: 0, custom: 0,
      },
    },
    ...(winner
      ? {
        winner: {
          policyKey: 'p', ruleId: 'r', effectType: 'deny', priority: 100,
        },
      }
      : {}),
    rules: [
      {
        policyKey: 'p', ruleId: 'r', priority: 100, effectType: 'deny', matched: true,
      },
      {
        policyKey: 'p',
        ruleId: 'off',
        priority: 1,
        effectType: 'allow',
        matched: false,
        discardedReason: 'disabled',
      },
    ],
  });

  it('names the winning rule', () => {
    const text = formatTrace(trace(true));
    expect(text).toContain('policy=p');
    expect(text).toContain('rule=r');
    expect(text).toContain('effect=deny');
  });

  it('says so when the decision came from a default', () => {
    expect(formatTrace(trace(false))).toContain('none (default decision)');
  });

  it('lists discarded rules only when asked', () => {
    expect(formatTrace(trace(true))).not.toContain('discarded rules');
    const verbose = formatTrace(trace(true), { includeDiscarded: true });
    expect(verbose).toContain('discarded rules');
    expect(verbose).toContain('reason=disabled');
  });
});
