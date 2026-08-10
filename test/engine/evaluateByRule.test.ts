import { describe, expect, it } from '@jest/globals';
import { createPolicyEngine } from '../../src/engine/createPolicyEngine.js';
import { RuleNotFoundError } from '../../src/errors/errors.js';
import type { Decision, RuntimeBundleV1 } from '../../src/engine/types.js';

/**
 * Evaluating one rule addressed by name.
 *
 * The property these exist to protect is that naming a rule and naming its
 * target are two ways of asking the same question. A rule-id path that answered
 * differently would be a second policy engine with a second set of bugs.
 */

const LOGIN = { service: 'auth', resource: 'login', action: 'authenticate' };
const REFUND = { service: 'payments', resource: 'refund', action: 'execute' };

const bundle = (): RuntimeBundleV1 => ({
  schemaVersion: 1,
  env: 'prod',
  policies: [
    {
      policyKey: 'login-protection',
      activeVersion: 1,
      defaults: { effect: 'allow' },
      rules: [{
        id: 'deny-after-five',
        status: 'active',
        priority: 100,
        target: LOGIN,
        when: { op: 'gte', path: 'ctx.failedAttempts', value: 5 },
        effect: { type: 'deny' },
      }],
    },
    {
      policyKey: 'refund-control',
      activeVersion: 1,
      defaults: { effect: 'deny' },
      rules: [{
        id: 'allow-small',
        status: 'active',
        priority: 100,
        target: REFUND,
        when: { op: 'lt', path: 'ctx.amount', value: 100 },
        effect: { type: 'allow' },
      }],
    },
  ],
});

const engine = (b: RuntimeBundleV1 = bundle()) => createPolicyEngine({
  getBundle: () => b,
  validateContext: false,
});

const decide = (
  input: Parameters<ReturnType<typeof createPolicyEngine>['evaluate']>[0],
  b?: RuntimeBundleV1,
): Decision => engine(b).evaluate(input);

describe('addressing a rule by id', () => {
  it('evaluates the rule when its condition holds', () => {
    expect(decide({ ruleId: 'deny-after-five', context: { failedAttempts: 6 } }))
      .toEqual({
        decision: 'deny', reason: 'rule', policyKey: 'login-protection', ruleId: 'deny-after-five',
      });
  });

  it('falls back to the owning policy default when the condition does not', () => {
    // The rule was asked for, so its policy is the one being consulted — the
    // same policy whose default would apply had the target been named instead.
    expect(decide({ ruleId: 'deny-after-five', context: { failedAttempts: 3 } }))
      .toEqual({ decision: 'allow', reason: 'default', policyKey: 'login-protection' });
  });

  it('ignores the rule target entirely', () => {
    // `allow-small` is about payments, and no auth target is mentioned anywhere
    // in the call. Naming the rule is the whole of the addressing.
    expect(decide({ ruleId: 'allow-small', context: { amount: 20 } }))
      .toMatchObject({ decision: 'allow', reason: 'rule', ruleId: 'allow-small' });
  });

  it('narrows to one policy when given a policyKey', () => {
    expect(decide({
      ruleId: 'deny-after-five', policyKey: 'login-protection', context: { failedAttempts: 6 },
    })).toMatchObject({ policyKey: 'login-protection', ruleId: 'deny-after-five' });
  });

  it('does not let other policies contribute their defaults', () => {
    // refund-control denies by default. Were it consulted, it would outrank the
    // allow this call is asking about — the exact cross-policy bleed the target
    // path is scoped to prevent.
    expect(decide({ ruleId: 'deny-after-five', context: { failedAttempts: 3 } }).decision)
      .toBe('allow');
  });
});

describe('answering by rule id and by target agree', () => {
  it.each([
    ['rule fires', { failedAttempts: 6 }],
    ['rule does not fire', { failedAttempts: 3 }],
    ['no context at all', {}],
  ])('%s', (_label, context) => {
    const byTarget = decide({ target: LOGIN, context });
    const byRule = decide({ ruleId: 'deny-after-five', context });

    expect(byRule).toEqual(byTarget);
  });
});

describe('a rule that cannot fire still yields its policy default', () => {
  const withStatus = (status: string): RuntimeBundleV1 => ({
    schemaVersion: 1,
    env: 'prod',
    policies: [{
      policyKey: 'p',
      activeVersion: 1,
      defaults: { effect: 'allow' },
      rules: [{ id: 'r', status, priority: 10, target: LOGIN, effect: { type: 'deny' } }],
    }],
  }) as RuntimeBundleV1;

  it('when it is disabled', () => {
    expect(decide({ ruleId: 'r' }, withStatus('disabled')))
      .toEqual({ decision: 'allow', reason: 'default', policyKey: 'p' });
  });

  it('and denies by default when the policy offers none', () => {
    const noDefault: RuntimeBundleV1 = {
      schemaVersion: 1,
      env: 'prod',
      policies: [{
        policyKey: 'p',
        activeVersion: 1,
        rules: [{
          id: 'r', status: 'disabled', priority: 10, target: LOGIN, effect: { type: 'allow' },
        }],
      }],
    };

    expect(decide({ ruleId: 'r' }, noDefault)).toEqual({ decision: 'deny', reason: 'default' });
  });
});

describe('duplicate rule ids across policies', () => {
  // Rule ids are unique only within a policy — the validator's duplicate check
  // resets per policy — so this bundle is legal and the address is ambiguous.
  const duplicated: RuntimeBundleV1 = {
    schemaVersion: 1,
    env: 'prod',
    policies: [
      {
        policyKey: 'first',
        activeVersion: 1,
        defaults: { effect: 'allow' },
        rules: [{
          id: 'shared', status: 'active', priority: 10, target: LOGIN, effect: { type: 'allow' },
        }],
      },
      {
        policyKey: 'second',
        activeVersion: 1,
        defaults: { effect: 'deny' },
        rules: [{
          id: 'shared', status: 'active', priority: 10, target: LOGIN, effect: { type: 'deny' },
        }],
      },
    ],
  };

  it('resolves the first in bundle order', () => {
    expect(decide({ ruleId: 'shared' }, duplicated))
      .toMatchObject({ decision: 'allow', policyKey: 'first' });
  });

  it('is disambiguated by policyKey', () => {
    expect(decide({ ruleId: 'shared', policyKey: 'second' }, duplicated))
      .toMatchObject({ decision: 'deny', policyKey: 'second' });
  });
});

describe('a rule that is not there', () => {
  it('throws rather than denying', () => {
    // A denial would be indistinguishable from a policy decision, and a typo
    // would look like a working deny nobody investigates.
    expect(() => decide({ ruleId: 'no-such-rule' })).toThrow(RuleNotFoundError);
  });

  it('carries a stable code and the id it could not find', () => {
    try {
      decide({ ruleId: 'no-such-rule' });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleNotFoundError);
      expect((error as RuleNotFoundError).code).toBe('RULE_NOT_FOUND');
      expect((error as RuleNotFoundError).details).toMatchObject({ ruleId: 'no-such-rule' });
    }
  });

  it('throws when the policy does not exist', () => {
    expect(() => decide({ ruleId: 'deny-after-five', policyKey: 'nope' }))
      .toThrow(/No policy "nope"/);
  });

  it('throws when the rule is not in the policy named', () => {
    expect(() => decide({ ruleId: 'allow-small', policyKey: 'login-protection' }))
      .toThrow(/has no rule "allow-small"/);
  });

  it('refuses the engine default marker', () => {
    // `__default__` is what the engine calls a synthesised policy default. It is
    // not a rule, and nothing in the validator reserves the name.
    expect(() => decide({ ruleId: '__default__' })).toThrow(RuleNotFoundError);
  });
});

describe('traces', () => {
  it('report only the addressed rule', () => {
    const result = engine().evaluateWithTrace(
      { ruleId: 'deny-after-five', context: { failedAttempts: 6 } },
      { level: 'full', force: true },
    );

    expect(result.decision).toBe('deny');
    const trace = result.trace as { rules: { ruleId: string }[]; target: unknown };
    // The rules of other policies were never candidates, so listing them as
    // discarded would be noise rather than explanation.
    expect(trace.rules.map((r) => r.ruleId)).toEqual(['deny-after-five']);
    // No target was requested, so the trace records what the rule covers.
    expect(trace.target).toEqual(LOGIN);
  });
});
