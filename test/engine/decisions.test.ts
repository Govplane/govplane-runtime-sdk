import { describe, expect, it } from '@jest/globals';
import { createPolicyEngine } from '../../src/engine/createPolicyEngine.js';
import type { RuntimeBundleV1 } from '../../src/engine/types.js';

/**
 * Decision semantics.
 *
 * These pin the behaviour `govplane simulate` reports to users: effect
 * precedence, priority ordering, how defaults are applied, and what happens
 * when nothing matches. The engine was carried over from 1.x precisely so this
 * behaviour would not shift; these tests are what makes that claim checkable.
 */

const TARGET = { service: 'auth', resource: 'login', action: 'authenticate' };

interface RuleSpec {
  id: string;
  effect: unknown;
  priority?: number;
  status?: string;
  when?: unknown;
  thenEffect?: unknown;
  elseEffect?: unknown;
  target?: unknown;
}

const bundleOf = (
  policies: { policyKey: string; defaults?: unknown; rules: RuleSpec[] }[],
): RuntimeBundleV1 => ({
  schemaVersion: 1,
  env: 'prod',
  policies: policies.map((policy) => ({
    policyKey: policy.policyKey,
    activeVersion: 1,
    defaults: policy.defaults,
    rules: policy.rules.map((rule) => ({
      status: 'active',
      priority: 10,
      target: TARGET,
      ...rule,
    })),
  })),
}) as RuntimeBundleV1;

const decide = (
  bundle: RuntimeBundleV1,
  context: Record<string, unknown> = {},
): ReturnType<ReturnType<typeof createPolicyEngine>['evaluate']> => createPolicyEngine({
  getBundle: () => bundle,
  validateContext: false,
}).evaluate({ target: TARGET, context });

const THROTTLE = { limit: 100, windowSeconds: 60, key: 'ctx.userId' };
const KILL = { service: 'auth', reason: 'incident' };

describe('effect precedence', () => {
  it('ranks kill_switch above everything', () => {
    const decision = decide(bundleOf([{
      policyKey: 'p',
      rules: [
        { id: 'allow', effect: { type: 'allow' }, priority: 100 },
        { id: 'deny', effect: { type: 'deny' }, priority: 90 },
        { id: 'kill', effect: { type: 'kill_switch', killSwitch: KILL }, priority: 1 },
      ],
    }]));

    // Priority does not rescue a lower-precedence effect: kill_switch wins at
    // priority 1 over a deny at 90.
    expect(decision).toMatchObject({ decision: 'kill_switch', ruleId: 'kill' });
  });

  it('ranks deny above throttle, allow and custom', () => {
    expect(decide(bundleOf([{
      policyKey: 'p',
      rules: [
        { id: 'allow', effect: { type: 'allow' }, priority: 100 },
        { id: 'throttle', effect: { type: 'throttle', throttle: THROTTLE }, priority: 100 },
        { id: 'custom', effect: { type: 'custom', value: 'x' }, priority: 100 },
        { id: 'deny', effect: { type: 'deny' }, priority: 1 },
      ],
    }]))).toMatchObject({ decision: 'deny', ruleId: 'deny' });
  });

  it('ranks throttle above allow', () => {
    expect(decide(bundleOf([{
      policyKey: 'p',
      rules: [
        { id: 'allow', effect: { type: 'allow' }, priority: 100 },
        { id: 'throttle', effect: { type: 'throttle', throttle: THROTTLE }, priority: 1 },
      ],
    }]))).toMatchObject({ decision: 'throttle' });
  });

  it('ranks allow above custom', () => {
    expect(decide(bundleOf([{
      policyKey: 'p',
      rules: [
        { id: 'custom', effect: { type: 'custom', value: 'x' }, priority: 100 },
        { id: 'allow', effect: { type: 'allow' }, priority: 1 },
      ],
    }]))).toMatchObject({ decision: 'allow' });
  });

  it('picks the strictest throttle, not the highest priority one', () => {
    const decision = decide(bundleOf([{
      policyKey: 'p',
      rules: [
        {
          id: 'loose',
          priority: 100,
          effect: { type: 'throttle', throttle: { limit: 1000, windowSeconds: 60, key: 'k' } },
        },
        {
          id: 'strict',
          priority: 1,
          effect: { type: 'throttle', throttle: { limit: 10, windowSeconds: 60, key: 'k' } },
        },
      ],
    }]));

    expect(decision).toMatchObject({ decision: 'throttle', ruleId: 'strict' });
  });
});

describe('rule ordering within one effect', () => {
  it('prefers the higher priority', () => {
    expect(decide(bundleOf([{
      policyKey: 'p',
      rules: [
        { id: 'low', effect: { type: 'deny' }, priority: 1 },
        { id: 'high', effect: { type: 'deny' }, priority: 100 },
      ],
    }]))).toMatchObject({ ruleId: 'high' });
  });

  it('breaks a priority tie by policyKey then ruleId', () => {
    expect(decide(bundleOf([
      { policyKey: 'b-policy', rules: [{ id: 'z', effect: { type: 'deny' }, priority: 10 }] },
      { policyKey: 'a-policy', rules: [{ id: 'a', effect: { type: 'deny' }, priority: 10 }] },
    ]))).toMatchObject({ policyKey: 'a-policy', ruleId: 'a' });
  });
});

describe('rules that do not apply', () => {
  it('skips a rule whose status is not exactly "active"', () => {
    // The engine tests `status !== "active"`, so a rule with no status at all
    // never fires. This is why `govplane build` always writes one.
    expect(decide(bundleOf([{
      policyKey: 'p',
      defaults: { effect: 'allow' },
      rules: [{ id: 'disabled', effect: { type: 'deny' }, status: 'disabled' }],
    }]))).toMatchObject({ decision: 'allow', reason: 'default' });

    expect(decide(bundleOf([{
      policyKey: 'p',
      defaults: { effect: 'allow' },
      rules: [{ id: 'statusless', effect: { type: 'deny' }, status: undefined }],
    }]))).toMatchObject({ decision: 'allow', reason: 'default' });
  });

  it('skips a rule targeting something else', () => {
    // The rule does not fire, and because it is the policy's only rule the
    // policy governs nothing here either — so its allow default does not stand
    // in, and the target falls to deny-by-default.
    expect(decide(bundleOf([{
      policyKey: 'p',
      defaults: { effect: 'allow' },
      rules: [{
        id: 'elsewhere',
        effect: { type: 'deny' },
        target: { service: 'other', resource: 'x', action: 'y' },
      }],
    }]))).toEqual({ decision: 'deny', reason: 'default' });
  });

  it('skips a rule whose when is false and which has no elseEffect', () => {
    expect(decide(
      bundleOf([{
        policyKey: 'p',
        defaults: { effect: 'allow' },
        rules: [{
          id: 'conditional',
          effect: { type: 'deny' },
          when: { op: 'gte', path: 'ctx.n', value: 5 },
        }],
      }]),
      { n: 1 },
    )).toMatchObject({ decision: 'allow', reason: 'default' });
  });
});

describe('thenEffect and elseEffect', () => {
  const conditional = (thenEffect: unknown, elseEffect?: unknown) => bundleOf([{
    policyKey: 'p',
    rules: [{
      id: 'branching',
      effect: { type: 'allow' },
      when: { op: 'gte', path: 'ctx.n', value: 5 },
      thenEffect,
      ...(elseEffect === undefined ? {} : { elseEffect }),
    }],
  }]);

  it('applies thenEffect when the condition holds', () => {
    expect(decide(conditional({ type: 'deny' }), { n: 6 })).toMatchObject({ decision: 'deny' });
  });

  it('applies elseEffect when it does not', () => {
    expect(decide(conditional({ type: 'deny' }, { type: 'allow' }), { n: 1 }))
      .toMatchObject({ decision: 'allow', reason: 'rule' });
  });

  it('falls back to effect when there is no thenEffect', () => {
    const bundle = bundleOf([{
      policyKey: 'p',
      rules: [{
        id: 'plain',
        effect: { type: 'deny' },
        when: { op: 'gte', path: 'ctx.n', value: 5 },
      }],
    }]);
    expect(decide(bundle, { n: 6 })).toMatchObject({ decision: 'deny' });
  });
});

describe('defaults', () => {
  /**
   * A policy in scope for the target — it has a rule aimed here — whose rule
   * did not fire. That is the situation a default exists for.
   */
  const inScopeButNoMatch = (defaults: unknown) => bundleOf([{
    policyKey: 'p',
    defaults,
    rules: [{
      id: 'never-fires',
      effect: { type: 'deny' },
      when: { op: 'gte', path: 'ctx.n', value: 5 },
    }],
  }]);

  it('applies a policy default when no rule in that policy matched', () => {
    expect(decide(inScopeButNoMatch({ effect: 'deny' }), { n: 0 }))
      .toMatchObject({ decision: 'deny', reason: 'default', policyKey: 'p' });
  });

  it('reports no ruleId for a default decision', () => {
    expect(decide(inScopeButNoMatch({ effect: 'allow' }), { n: 0 }).ruleId)
      .toBeUndefined();
  });

  it('lets any explicit rule beat a default', () => {
    expect(decide(bundleOf([
      { policyKey: 'a', defaults: { effect: 'deny' }, rules: [] },
      { policyKey: 'b', rules: [{ id: 'r', effect: { type: 'deny' }, priority: 0 }] },
    ]))).toMatchObject({ reason: 'rule', ruleId: 'r' });
  });

  it('carries the descriptor through for each default effect type', () => {
    expect(decide(inScopeButNoMatch({ effect: 'kill_switch', killSwitch: KILL }), { n: 0 }))
      .toMatchObject({ decision: 'kill_switch', killSwitch: KILL });

    expect(decide(inScopeButNoMatch({ effect: 'throttle', throttle: THROTTLE }), { n: 0 }))
      .toMatchObject({ decision: 'throttle', throttle: THROTTLE });

    const custom = { effect: 'custom', customEffect: '{"tier":"gold"}' };
    expect(decide(inScopeButNoMatch(custom), { n: 0 }))
      .toMatchObject({ decision: 'custom', value: '{"tier":"gold"}' });
  });

  it('ignores a kill_switch or throttle default with no descriptor', () => {
    expect(decide(inScopeButNoMatch({ effect: 'kill_switch' }), { n: 0 }))
      .toMatchObject({ decision: 'deny', reason: 'default' });
  });
});

/**
 * A policy's default speaks only for the targets that policy governs.
 *
 * Without this, every policy answers every question: one policy that denies by
 * default denies every target in the bundle, including those another policy
 * explicitly allows, because deny outranks allow. That made a bundle's decisions
 * depend on policies with nothing to do with the request.
 */
describe('defaults are scoped to the policy that owns the target', () => {
  const OTHER = { service: 'payments', resource: 'refund', action: 'execute' };

  it('ignores the default of a policy with no rule aimed at the target', () => {
    // login-protection allows by default; refund-control denies by default and
    // is about something else entirely. The login request is allowed.
    const bundle = bundleOf([
      {
        policyKey: 'login-protection',
        defaults: { effect: 'allow' },
        rules: [{
          id: 'deny-after-five-failures',
          effect: { type: 'deny' },
          when: { op: 'gte', path: 'ctx.failedAttempts', value: 5 },
        }],
      },
      {
        policyKey: 'refund-control',
        defaults: { effect: 'deny' },
        rules: [{ id: 'big-refund', effect: { type: 'deny' }, target: OTHER }],
      },
    ]);

    expect(decide(bundle, { failedAttempts: 3 }))
      .toMatchObject({ decision: 'allow', reason: 'default', policyKey: 'login-protection' });

    // The same bundle still denies once the owning policy's rule fires.
    expect(decide(bundle, { failedAttempts: 6 }))
      .toMatchObject({ decision: 'deny', reason: 'rule', ruleId: 'deny-after-five-failures' });
  });

  it('treats a policy with no rules as governing nothing', () => {
    expect(decide(bundleOf([
      { policyKey: 'floor', defaults: { effect: 'deny' }, rules: [] },
      {
        policyKey: 'p',
        defaults: { effect: 'allow' },
        rules: [{
          id: 'r',
          effect: { type: 'deny' },
          when: { op: 'gte', path: 'ctx.n', value: 5 },
        }],
      },
    ]), { n: 0 })).toMatchObject({ decision: 'allow', policyKey: 'p' });
  });

  it('still denies a target no policy governs', () => {
    // Silence is never permission: an uncovered target falls to deny-by-default.
    expect(decide(bundleOf([{
      policyKey: 'p',
      defaults: { effect: 'allow' },
      rules: [{ id: 'r', effect: { type: 'deny' }, target: OTHER }],
    }]))).toEqual({ decision: 'deny', reason: 'default' });
  });

  it('keeps a policy in scope when the rule aimed at the target is disabled', () => {
    // Turning a rule off must not swap the policy's default for the global one:
    // that would silently deny everything the rule covered.
    expect(decide(bundleOf([{
      policyKey: 'p',
      defaults: { effect: 'allow' },
      rules: [{ id: 'off', effect: { type: 'deny' }, status: 'disabled' }],
    }]))).toMatchObject({ decision: 'allow', reason: 'default', policyKey: 'p' });
  });
});

describe('deny by default', () => {
  it('denies when nothing matches and no policy offers a default', () => {
    expect(decide(bundleOf([{ policyKey: 'p', rules: [] }])))
      .toEqual({ decision: 'deny', reason: 'default' });
  });

  it('denies when there is no bundle at all', () => {
    const engine = createPolicyEngine({ getBundle: () => undefined, validateContext: false });
    expect(engine.evaluate({ target: TARGET })).toEqual({ decision: 'deny', reason: 'default' });
  });

  it('denies when the bundle is not schema version 1', () => {
    const engine = createPolicyEngine({
      getBundle: () => ({ schemaVersion: 2 } as unknown as RuntimeBundleV1),
      validateContext: false,
    });
    expect(engine.evaluate({ target: TARGET })).toEqual({ decision: 'deny', reason: 'default' });
  });
});

describe('custom effects', () => {
  const bundle = bundleOf([{
    policyKey: 'p',
    rules: [{ id: 'c', effect: { type: 'custom', value: '{"tier":"gold"}' } }],
  }]);

  it('returns the raw value by default', () => {
    const decision = decide(bundle);
    expect(decision).toMatchObject({ decision: 'custom', value: '{"tier":"gold"}' });
    expect((decision as { parsedValue?: unknown }).parsedValue).toBeUndefined();
  });

  it('parses the value when asked', () => {
    const engine = createPolicyEngine({
      getBundle: () => bundle,
      validateContext: false,
      parseCustomEffect: true,
    });
    expect(engine.evaluate({ target: TARGET }))
      .toMatchObject({ parsedValue: { tier: 'gold' } });
  });

  it('leaves parsedValue undefined when the value is not JSON', () => {
    const engine = createPolicyEngine({
      getBundle: () => bundleOf([{
        policyKey: 'p',
        rules: [{ id: 'c', effect: { type: 'custom', value: 'not json' } }],
      }]),
      validateContext: false,
      parseCustomEffect: true,
    });
    const decision = engine.evaluate({ target: TARGET });
    expect((decision as { parsedValue?: unknown }).parsedValue).toBeUndefined();
    expect(decision).toMatchObject({ value: 'not json' });
  });
});

describe('traces reflect the same decision', () => {
  const bundle = bundleOf([{
    policyKey: 'p',
    defaults: { effect: 'allow' },
    rules: [
      { id: 'winner', effect: { type: 'deny' }, priority: 100 },
      { id: 'off', effect: { type: 'deny' }, status: 'disabled' },
      {
        id: 'elsewhere',
        effect: { type: 'deny' },
        target: { service: 'other', resource: 'x', action: 'y' },
      },
    ],
  }]);

  it('names the winning rule and counts what was considered', () => {
    const engine = createPolicyEngine({ getBundle: () => bundle, validateContext: false });
    const result = engine.evaluateWithTrace({ target: TARGET }, { level: 'full', force: true });

    expect(result.decision).toBe('deny');
    expect(result.trace?.winner).toMatchObject({ ruleId: 'winner', effectType: 'deny' });
    expect(result.trace?.summary.rulesSeen).toBe(3);
    expect(result.trace?.summary.matched).toBe(1);
  });

  it('records why each rule was discarded at full level', () => {
    const engine = createPolicyEngine({ getBundle: () => bundle, validateContext: false });
    const result = engine.evaluateWithTrace({ target: TARGET }, { level: 'full', force: true });

    const reasons = (result.trace as { rules: { ruleId: string; discardedReason?: string }[] })
      .rules;
    expect(reasons.find((rule) => rule.ruleId === 'off')?.discardedReason).toBe('disabled');
    expect(reasons.find((rule) => rule.ruleId === 'elsewhere')?.discardedReason)
      .toBe('target_mismatch');
  });

  it('omits the per-rule list below full level', () => {
    const engine = createPolicyEngine({ getBundle: () => bundle, validateContext: false });
    const result = engine.evaluateWithTrace({ target: TARGET }, { level: 'sampled', force: true });

    expect(result.trace).toBeDefined();
    expect((result.trace as { rules?: unknown }).rules).toBeUndefined();
  });

  it('produces no trace when tracing is off', () => {
    const engine = createPolicyEngine({ getBundle: () => bundle, validateContext: false });
    expect(engine.evaluateWithTrace({ target: TARGET }, { level: 'off' }).trace).toBeUndefined();
  });
});
