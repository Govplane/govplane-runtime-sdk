import { describe, expect, it } from '@jest/globals';
import { createPolicyEngine } from '../../src/engine/createPolicyEngine.js';
import { SignalMissingError } from '../../src/errors/errors.js';
import type { Decision, RuntimeBundleV1 } from '../../src/engine/types.js';
import type { SignalsConfig } from '../../src/engine/signals.js';

/**
 * Required signals.
 *
 * The hazard: a policy that denies when `piiScore > 0.8` silently allows when
 * `piiScore` is absent, because a comparison against `NaN` is false. These
 * tests pin that a declared dependency turns that silence into the outcome the
 * host chose, and that the check can be neither bypassed by addressing a rule
 * by name nor used to turn "no bundle" into a permission.
 */

const AGENT = { service: 'agent', resource: 'send_email', action: 'invoke' };
const LOOKUP = { service: 'catalogue', resource: 'product', action: 'read' };

/** Denies email sends with a high PII score; allows everything else. */
const bundle: RuntimeBundleV1 = {
  schemaVersion: 1,
  env: 'prod',
  policies: [{
    policyKey: 'data-handling',
    activeVersion: 1,
    defaults: { effect: 'allow' },
    rules: [{
      id: 'r_pii_export',
      status: 'active',
      priority: 10,
      target: AGENT,
      when: { op: 'gt', path: 'ctx.piiScore', value: 0.8 },
      effect: { type: 'deny' },
    }, {
      id: 'r_lookup',
      status: 'active',
      priority: 10,
      target: LOOKUP,
      effect: { type: 'allow' },
    }],
  }],
};

const engineWith = (
  signals: SignalsConfig,
  getBundle: () => RuntimeBundleV1 | undefined = () => bundle,
) => createPolicyEngine({ getBundle, validateContext: false, signals });

const decide = (
  signals: SignalsConfig,
  context: Record<string, unknown>,
  target = AGENT,
): Decision => engineWith(signals).evaluate({ target, context });

describe('without a declaration', () => {
  it('fails open when the score is absent — the gap the feature closes', () => {
    const engine = createPolicyEngine({ getBundle: () => bundle, validateContext: false });
    expect(engine.evaluate({ target: AGENT, context: {} }).decision).toBe('allow');
    expect(engine.evaluate({ target: AGENT, context: { piiScore: 0.9 } }).decision).toBe('deny');
  });
});

describe('presence', () => {
  const required: SignalsConfig = { required: ['piiScore'] };

  it('treats an absent key as missing', () => {
    expect(decide(required, {})).toEqual({
      decision: 'deny', reason: 'signal_missing', missingSignals: ['piiScore'],
    });
  });

  it.each([
    ['a numeric string', '0.5'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['a boolean', true],
  ])('treats %s as missing', (_label, value) => {
    expect(decide(required, { piiScore: value }).reason).toBe('signal_missing');
  });

  it('treats zero as present', () => {
    // A score of exactly 0 is the most likely value a detector produces, and
    // the one a truthiness check would lose.
    const decision = decide(required, { piiScore: 0 });
    expect(decision.reason).not.toBe('signal_missing');
    expect(decision.decision).toBe('allow');
  });

  it('evaluates normally once the signal is supplied', () => {
    expect(decide(required, { piiScore: 0.95 })).toMatchObject({
      decision: 'deny', reason: 'rule', ruleId: 'r_pii_export',
    });
  });

  it('lists every missing signal once, in declaration order', () => {
    const decision = decide(
      { required: ['piiScore', { signal: 'injectionScore' }, 'piiScore'] },
      { tenant: 'acme' },
    );
    expect(decision).toMatchObject({ missingSignals: ['piiScore', 'injectionScore'] });
  });
});

describe('onMissing', () => {
  it('defaults to deny', () => {
    expect(decide({ required: ['piiScore'] }, {}).decision).toBe('deny');
  });

  it('deny', () => {
    expect(decide({ required: ['piiScore'], onMissing: 'deny' }, {})).toEqual({
      decision: 'deny', reason: 'signal_missing', missingSignals: ['piiScore'],
    });
  });

  it('kill_switch names the service of the target that was gated', () => {
    expect(decide({ required: ['piiScore'], onMissing: 'kill_switch' }, {})).toEqual({
      decision: 'kill_switch',
      reason: 'signal_missing',
      killSwitch: { service: 'agent', reason: 'signal_missing' },
      missingSignals: ['piiScore'],
    });
  });

  it('allow is an explicit choice, and still says why', () => {
    expect(decide({ required: ['piiScore'], onMissing: 'allow' }, {})).toEqual({
      decision: 'allow', reason: 'signal_missing', missingSignals: ['piiScore'],
    });
  });

  it('throw raises SignalMissingError with a stable code', () => {
    const engine = engineWith({ required: ['piiScore'], onMissing: 'throw' });
    let caught: unknown;
    try {
      engine.evaluate({ target: AGENT, context: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SignalMissingError);
    const error = caught as SignalMissingError;
    expect(error.code).toBe('SIGNAL_MISSING');
    expect(error.missingSignals).toEqual(['piiScore']);
    expect(error.details).toEqual({ missingSignals: ['piiScore'], target: AGENT });
  });

  it('reduces the way the decision would', () => {
    const engine = engineWith({ required: ['piiScore'] });
    expect(engine.evaluate({ target: AGENT, context: {} }, { asBoolean: true })).toBe(false);
    expect(engine.evaluate({ target: AGENT, context: {} }, { asBinary: true })).toBe(0);
    expect(engine.evaluate({ target: AGENT, context: {} }, { effectOnly: true })).toBe('deny');
  });
});

describe('per-target scope', () => {
  const scoped: SignalsConfig = {
    required: [
      { signal: 'piiScore', when: { service: 'agent' } },
      { signal: 'injectionScore' },
    ],
  };

  it('applies a scoped requirement only to matching targets', () => {
    expect(decide(scoped, { injectionScore: 0.1 }, AGENT))
      .toMatchObject({ missingSignals: ['piiScore'] });
    expect(decide(scoped, { injectionScore: 0.1 }, LOOKUP).decision).toBe('allow');
  });

  it('applies an unscoped requirement everywhere', () => {
    expect(decide(scoped, { piiScore: 0.1 }, LOOKUP))
      .toMatchObject({ missingSignals: ['injectionScore'] });
  });

  it('matches every field named in the scope', () => {
    const narrow: SignalsConfig = {
      required: [{ signal: 'piiScore', when: { service: 'agent', action: 'invoke' } }],
    };
    expect(decide(narrow, {}, AGENT).reason).toBe('signal_missing');
    expect(decide(narrow, {}, { ...AGENT, action: 'preview' }).reason).toBe('default');
  });
});

describe('placement in the evaluation', () => {
  it('gates a rule addressed by name using the rule\'s own target', () => {
    // Otherwise `{ ruleId }` would be a way to ask the question without
    // supplying the signal the question depends on.
    const engine = engineWith({
      required: [{ signal: 'piiScore', when: { service: 'agent' } }],
    });
    expect(engine.evaluate({ ruleId: 'r_pii_export', context: {} })).toMatchObject({
      decision: 'deny', reason: 'signal_missing',
    });
    expect(engine.evaluate({ ruleId: 'r_lookup', context: {} }).decision).toBe('allow');
  });

  it('still reports an unknown rule as such', () => {
    const engine = engineWith({ required: ['piiScore'] });
    expect(() => engine.evaluate({ ruleId: 'nope', context: {} })).toThrow(/No rule/);
  });

  it('cannot turn a missing bundle into a permission', () => {
    const engine = engineWith({ required: ['piiScore'], onMissing: 'allow' }, () => undefined);
    expect(engine.evaluate({ target: AGENT, context: {} })).toEqual({
      decision: 'deny', reason: 'default',
    });
  });

  it('lets a context policy violation win', () => {
    const engine = createPolicyEngine({
      getBundle: () => bundle,
      validateContext: true,
      contextPolicy: { allowedKeys: ['piiScore'] },
      signals: { required: ['piiScore'] },
    });
    expect(() => engine.evaluate({ target: AGENT, context: { email: 'x@y' } }))
      .toThrow(/not allowed/);
  });

  it('fires onDecision like any other decision', () => {
    const seen: Decision[] = [];
    const engine = createPolicyEngine({
      getBundle: () => bundle,
      validateContext: false,
      signals: { required: ['piiScore'] },
      onDecision: (decision) => { seen.push(decision); },
    });
    engine.evaluate({ target: AGENT, context: {} });
    expect(seen).toEqual([{
      decision: 'deny', reason: 'signal_missing', missingSignals: ['piiScore'],
    }]);
  });
});

describe('with a trace', () => {
  it('reports that no rule was consulted', () => {
    const engine = engineWith({ required: ['piiScore'] });
    const result = engine.evaluateWithTrace(
      { target: AGENT, context: { tenant: 'acme' } },
      { level: 'full', force: true },
    );
    expect(result).toMatchObject({ decision: 'deny', reason: 'signal_missing' });
    expect(result.trace?.winner).toBeUndefined();
    expect(result.trace?.summary).toMatchObject({ policiesSeen: 0, rulesSeen: 0, matched: 0 });
    // The privacy property of traces holds for this path too.
    expect((result.trace as unknown as Record<string, unknown>).context).toBeUndefined();
  });

  it('is an error-level trace, like any other deny', () => {
    const events: unknown[] = [];
    const engine = createPolicyEngine({
      getBundle: () => bundle,
      validateContext: false,
      signals: { required: ['piiScore'] },
      traceSink: (event) => { events.push(event); },
    });
    engine.evaluateWithTrace({ target: AGENT, context: {} }, { level: 'errors' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'deny', reason: 'signal_missing' });
  });
});
