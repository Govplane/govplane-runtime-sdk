import { describe, expect, it } from '@jest/globals';
import { targetMatch, targetMatchesScope } from '../../src/engine/target.js';

/**
 * Target matching.
 *
 * `targetMatch` is exact on all three fields. `targetMatchesScope` reads an
 * omitted field as "any" — and only an omitted one, so an empty string does
 * not silently widen a scope.
 */

const T = { service: 'agent', resource: 'send_email', action: 'invoke' };

describe('targetMatch', () => {
  it('requires all three fields to agree', () => {
    expect(targetMatch(T, { ...T })).toBe(true);
    expect(targetMatch(T, { ...T, service: 'other' })).toBe(false);
    expect(targetMatch(T, { ...T, resource: 'other' })).toBe(false);
    expect(targetMatch(T, { ...T, action: 'other' })).toBe(false);
  });
});

describe('targetMatchesScope', () => {
  it('matches everything with an empty scope', () => {
    expect(targetMatchesScope({}, T)).toBe(true);
  });

  it.each([
    [{ service: 'agent' }, true],
    [{ service: 'other' }, false],
    [{ resource: 'send_email' }, true],
    [{ action: 'invoke' }, true],
    [{ service: 'agent', action: 'invoke' }, true],
    [{ service: 'agent', action: 'preview' }, false],
    [{ service: 'agent', resource: 'send_email', action: 'invoke' }, true],
  ])('%j → %s', (scope, expected) => {
    expect(targetMatchesScope(scope, T)).toBe(expected);
  });

  it('does not read an empty string as a wildcard', () => {
    expect(targetMatchesScope({ service: '' }, T)).toBe(false);
  });
});
