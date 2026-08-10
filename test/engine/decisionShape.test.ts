import { describe, expect, it } from '@jest/globals';
import { createPolicyEngine } from '../../src/engine/createPolicyEngine.js';
import { isPermissive, shapeDecision } from '../../src/engine/decisionShape.js';
import { ConfigurationError } from '../../src/errors/errors.js';
import type { Decision, RuntimeBundleV1 } from '../../src/engine/types.js';

/**
 * Reducing a decision to a boolean, a bit, or its effect name.
 *
 * These pin the one judgement the mapping encodes — that `throttle` is not a
 * permission — and the fact that a caller who asks for nothing gets exactly what
 * they got before the option existed.
 */

const TARGET = { service: 'auth', resource: 'login', action: 'authenticate' };

/** A bundle whose single rule always fires with the given effect. */
const bundleWith = (effect: unknown): RuntimeBundleV1 => ({
  schemaVersion: 1,
  env: 'prod',
  policies: [{
    policyKey: 'p',
    activeVersion: 1,
    defaults: { effect: 'deny' },
    rules: [{ id: 'r', status: 'active', priority: 10, target: TARGET, effect }],
  }],
}) as RuntimeBundleV1;

const engineFor = (effect: unknown) => createPolicyEngine({
  getBundle: () => bundleWith(effect),
  validateContext: false,
});

const EFFECTS: [Decision['decision'], unknown][] = [
  ['allow', { type: 'allow' }],
  ['deny', { type: 'deny' }],
  ['custom', { type: 'custom', value: '{"tier":"gold"}' }],
  ['throttle', {
    type: 'throttle',
    throttle: { limit: 100, windowSeconds: 60, key: 'ctx.userId' },
  }],
  ['kill_switch', { type: 'kill_switch', killSwitch: { service: 'auth', reason: 'incident' } }],
];

const PERMITS: Decision['decision'][] = ['allow', 'custom'];

describe('isPermissive', () => {
  it.each(EFFECTS)('classifies %s', (name) => {
    expect(isPermissive(name)).toBe(PERMITS.includes(name));
  });

  it('treats throttle as not a permission', () => {
    // The spec classified deny and kill_switch as false and allow and custom as
    // true, and said nothing about throttle. It reduces to false: a boolean
    // cannot carry the limit, so a caller who saw `true` would proceed at an
    // unbounded rate — failing open on the one effect that exists to bound it.
    expect(isPermissive('throttle')).toBe(false);
  });
});

describe('asBoolean', () => {
  it.each(EFFECTS)('%s evaluates to the right boolean', (name, effect) => {
    expect(engineFor(effect).evaluate({ target: TARGET }, { asBoolean: true }))
      .toBe(PERMITS.includes(name));
  });
});

describe('asBinary', () => {
  it.each(EFFECTS)('%s evaluates to the right bit', (name, effect) => {
    expect(engineFor(effect).evaluate({ target: TARGET }, { asBinary: true }))
      .toBe(PERMITS.includes(name) ? 1 : 0);
  });
});

describe('effectOnly', () => {
  it.each(EFFECTS)('%s returns its own name and nothing else', (name, effect) => {
    expect(engineFor(effect).evaluate({ target: TARGET }, { effectOnly: true })).toBe(name);
  });

  it('drops the descriptors a full decision carries', () => {
    const shaped = engineFor(EFFECTS[3]![1]).evaluate({ target: TARGET }, { effectOnly: true });
    expect(shaped).toBe('throttle');
    expect(typeof shaped).toBe('string');
  });
});

describe('no options', () => {
  it('returns the decision untouched', () => {
    expect(engineFor({ type: 'allow' }).evaluate({ target: TARGET }))
      .toEqual({ decision: 'allow', reason: 'rule', policyKey: 'p', ruleId: 'r' });
  });

  it('is unchanged by an options object that asks for nothing', () => {
    expect(engineFor({ type: 'allow' }).evaluate({ target: TARGET }, {}))
      .toEqual({ decision: 'allow', reason: 'rule', policyKey: 'p', ruleId: 'r' });
  });
});

describe('the shapes are mutually exclusive', () => {
  const allow: Decision = { decision: 'allow', reason: 'rule' };

  it.each([
    [{ asBoolean: true, asBinary: true }],
    [{ asBoolean: true, effectOnly: true }],
    [{ asBinary: true, effectOnly: true }],
    [{ asBoolean: true, asBinary: true, effectOnly: true }],
  ])('rejects %s', (options) => {
    // Picking one silently would answer a question the caller did not ask.
    expect(() => shapeDecision(allow, options)).toThrow(ConfigurationError);
  });

  it('names the offending options in the error', () => {
    expect(() => shapeDecision(allow, { asBoolean: true, asBinary: true }))
      .toThrow(/asBoolean, asBinary/);
  });

  it('allows one on its own', () => {
    expect(shapeDecision(allow, { asBoolean: true })).toBe(true);
    expect(shapeDecision(allow, { asBinary: false, effectOnly: true })).toBe('allow');
  });
});
