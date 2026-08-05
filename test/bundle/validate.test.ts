import { describe, expect, it } from '@jest/globals';
import { validateBundle } from '../../src/bundle/validate.js';

const codes = (document: unknown, scope?: 'required' | 'optional'): string[] => validateBundle(
  document,
  scope === undefined ? {} : { scope },
).map((issue) => issue.code);

const valid = (): Record<string, unknown> => ({
  schemaVersion: 1,
  orgId: 'org_1',
  projectId: 'proj_1',
  env: 'prod',
  policies: [{
    policyKey: 'p',
    activeVersion: 1,
    defaults: { effect: 'allow' },
    rules: [{
      id: 'r',
      status: 'active',
      priority: 1,
      target: { service: 's', resource: 'r', action: 'a' },
      effect: { type: 'deny' },
    }],
  }],
});

const withRule = (rule: Record<string, unknown>): Record<string, unknown> => ({
  ...valid(),
  policies: [{ policyKey: 'p', activeVersion: 1, rules: [rule] }],
});

describe('document level', () => {
  it('accepts a valid bundle', () => {
    expect(validateBundle(valid())).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(codes(null)).toEqual(['DOCUMENT_NOT_OBJECT']);
    expect(codes([])).toEqual(['DOCUMENT_NOT_OBJECT']);
    expect(codes('text')).toEqual(['DOCUMENT_NOT_OBJECT']);
  });

  it('requires schemaVersion 1', () => {
    expect(codes({ ...valid(), schemaVersion: 2 })).toContain('INVALID_SCHEMA_VERSION');
    expect(codes({ ...valid(), schemaVersion: '1' })).toContain('INVALID_SCHEMA_VERSION');
  });

  it('requires scope by default and not under the optional profile', () => {
    const scopeless = { ...valid(), orgId: undefined, projectId: undefined };
    expect(codes(scopeless)).toContain('MISSING_SCOPE_FIELDS');
    expect(codes(scopeless, 'optional')).toEqual([]);
  });

  it('requires a known environment', () => {
    expect(codes({ ...valid(), env: undefined })).toContain('INVALID_ENV');
    expect(codes({ ...valid(), env: 'production' })).toContain('INVALID_ENV');
    ['prod', 'staging', 'dev', 'test'].forEach((env) => {
      expect(codes({ ...valid(), env })).toEqual([]);
    });
  });

  it('accepts any whole bundleVersion of 1 or more', () => {
    expect(codes({ ...valid(), bundleVersion: 1 })).toEqual([]);
    expect(codes({ ...valid(), bundleVersion: 512 })).toEqual([]);
    expect(codes({ ...valid(), bundleVersion: 0 })).toContain('INVALID_BUNDLE_VERSION');
    expect(codes({ ...valid(), bundleVersion: 1.5 })).toContain('INVALID_BUNDLE_VERSION');
    expect(codes({ ...valid(), bundleVersion: '3' })).toContain('INVALID_BUNDLE_VERSION');
  });

  it('requires policies to be an array, and stops there', () => {
    const result = validateBundle({ ...valid(), policies: {} });
    expect(result.map((issue) => issue.code)).toEqual(['POLICIES_NOT_ARRAY']);
  });

  it('reports every problem rather than the first', () => {
    expect(codes({ schemaVersion: 9, policies: [] }).length).toBeGreaterThan(2);
  });
});

describe('policies', () => {
  it('rejects a non-object policy', () => {
    expect(codes({ ...valid(), policies: [null] })).toContain('INVALID_POLICY');
  });

  it('requires a policyKey and a numeric activeVersion', () => {
    expect(codes({ ...valid(), policies: [{ rules: [] }] }))
      .toEqual(expect.arrayContaining(['MISSING_POLICY_KEY', 'INVALID_ACTIVE_VERSION']));
  });

  it('rejects duplicate policy keys', () => {
    expect(codes({
      ...valid(),
      policies: [
        { policyKey: 'same', activeVersion: 1, rules: [] },
        { policyKey: 'same', activeVersion: 1, rules: [] },
      ],
    })).toContain('DUPLICATE_POLICY_KEY');
  });

  it('requires rules to be an array', () => {
    expect(codes({ ...valid(), policies: [{ policyKey: 'p', activeVersion: 1 }] }))
      .toContain('RULES_NOT_ARRAY');
  });

  it('allows a policy with no defaults', () => {
    expect(codes({ ...valid(), policies: [{ policyKey: 'p', activeVersion: 1, rules: [] }] }))
      .toEqual([]);
  });
});

describe('policy defaults', () => {
  const withDefaults = (defaults: unknown): Record<string, unknown> => ({
    ...valid(),
    policies: [{
      policyKey: 'p', activeVersion: 1, defaults, rules: [],
    }],
  });

  it('requires a known effect', () => {
    expect(codes(withDefaults({ effect: 'maybe' }))).toContain('INVALID_DEFAULT_EFFECT');
    expect(codes(withDefaults('allow'))).toContain('INVALID_DEFAULT_EFFECT');
  });

  it('requires a service for kill_switch', () => {
    expect(codes(withDefaults({ effect: 'kill_switch' })))
      .toContain('MISSING_KILL_SWITCH_SERVICE');
    expect(codes(withDefaults({ effect: 'kill_switch', killSwitch: { service: 'payments' } })))
      .toEqual([]);
  });

  it('requires a complete throttle', () => {
    expect(codes(withDefaults({ effect: 'throttle' }))).toContain('INVALID_THROTTLE_DEFAULT');
    expect(codes(withDefaults({
      effect: 'throttle', throttle: { limit: 10, windowSeconds: 60 },
    }))).toContain('INVALID_THROTTLE_DEFAULT');
    expect(codes(withDefaults({
      effect: 'throttle', throttle: { limit: 10, windowSeconds: 60, key: 'ctx.userId' },
    }))).toEqual([]);
  });

  it('requires a customEffect for custom', () => {
    expect(codes(withDefaults({ effect: 'custom' }))).toContain('INVALID_CUSTOM_DEFAULT');
    expect(codes(withDefaults({ effect: 'custom', customEffect: '{}' }))).toEqual([]);
  });
});

describe('rules', () => {
  const base = {
    id: 'r',
    status: 'active',
    priority: 1,
    target: { service: 's', resource: 'r', action: 'a' },
    effect: { type: 'deny' },
  };

  it('rejects a non-object rule', () => {
    expect(codes(withRule(null as never))).toContain('INVALID_RULE');
  });

  it('requires an id and a numeric priority', () => {
    expect(codes(withRule({ ...base, id: undefined, priority: 'high' })))
      .toEqual(expect.arrayContaining(['MISSING_RULE_ID', 'INVALID_RULE_PRIORITY']));
  });

  it('rejects duplicate rule ids within a policy', () => {
    expect(codes({
      ...valid(),
      policies: [{ policyKey: 'p', activeVersion: 1, rules: [base, base] }],
    })).toContain('DUPLICATE_RULE_ID');
  });

  it('allows the same rule id in different policies', () => {
    expect(codes({
      ...valid(),
      policies: [
        { policyKey: 'a', activeVersion: 1, rules: [base] },
        { policyKey: 'b', activeVersion: 1, rules: [base] },
      ],
    })).toEqual([]);
  });

  it('requires a complete target', () => {
    expect(codes(withRule({ ...base, target: undefined }))).toContain('INVALID_RULE_TARGET');
    expect(codes(withRule({ ...base, target: { service: 's' } })))
      .toContain('INVALID_RULE_TARGET');
  });

  it('requires a valid effect', () => {
    expect(codes(withRule({ ...base, effect: undefined }))).toContain('INVALID_RULE_EFFECT');
    expect(codes(withRule({ ...base, effect: { type: 'maybe' } })))
      .toContain('INVALID_RULE_EFFECT');
    expect(codes(withRule({ ...base, effect: { type: 'custom' } })))
      .toContain('INVALID_RULE_EFFECT');
  });

  it('validates thenEffect and elseEffect the same way', () => {
    expect(codes(withRule({ ...base, thenEffect: { type: 'nope' } })))
      .toContain('INVALID_RULE_EFFECT');
    expect(codes(withRule({ ...base, elseEffect: { type: 'nope' } })))
      .toContain('INVALID_RULE_EFFECT');
  });
});

describe('conditions', () => {
  const base = {
    id: 'r',
    status: 'active',
    priority: 1,
    target: { service: 's', resource: 'r', action: 'a' },
    effect: { type: 'deny' },
  };

  const withWhen = (when: unknown): string[] => codes(withRule({ ...base, when }));

  it('accepts every supported operator', () => {
    expect(withWhen({ op: 'eq', path: 'ctx.a', value: 1 })).toEqual([]);
    expect(withWhen({ op: 'exists', path: 'ctx.a' })).toEqual([]);
    expect(withWhen({ op: 'in', path: 'ctx.a', values: ['x'] })).toEqual([]);
    expect(withWhen({ op: 'not', condition: { op: 'exists', path: 'ctx.a' } })).toEqual([]);
    expect(withWhen({ op: 'and', conditions: [{ op: 'exists', path: 'ctx.a' }] })).toEqual([]);
  });

  it('accepts the legacy args and arg spellings the engine evaluates', () => {
    expect(withWhen({ op: 'or', args: [{ op: 'exists', path: 'ctx.a' }] })).toEqual([]);
    expect(withWhen({ op: 'not', arg: { op: 'exists', path: 'ctx.a' } })).toEqual([]);
  });

  it('rejects an unknown operator', () => {
    expect(withWhen({ op: 'approximately', path: 'ctx.a', value: 1 }))
      .toContain('UNSUPPORTED_CONDITION_OPERATOR');
  });

  it('rejects a non-object condition', () => {
    expect(withWhen('always')).toContain('INVALID_CONDITION_AST');
  });

  it('requires a path on comparisons and exists', () => {
    expect(withWhen({ op: 'eq', value: 1 })).toContain('INVALID_CONDITION_AST');
    expect(withWhen({ op: 'exists' })).toContain('INVALID_CONDITION_AST');
  });

  it('requires a scalar value on comparisons', () => {
    expect(withWhen({ op: 'eq', path: 'ctx.a', value: { nested: true } }))
      .toContain('INVALID_CONDITION_AST');
    expect(withWhen({ op: 'eq', path: 'ctx.a', value: null })).toEqual([]);
  });

  it('requires non-empty values for in', () => {
    expect(withWhen({ op: 'in', path: 'ctx.a', values: [] }))
      .toContain('INVALID_CONDITION_AST');
    expect(withWhen({ op: 'in', path: 'ctx.a' })).toContain('INVALID_CONDITION_AST');
  });

  it('requires non-empty branches for and/or', () => {
    expect(withWhen({ op: 'and', conditions: [] })).toContain('INVALID_CONDITION_AST');
    expect(withWhen({ op: 'or' })).toContain('INVALID_CONDITION_AST');
  });

  it('requires an inner condition for not', () => {
    expect(withWhen({ op: 'not' })).toContain('INVALID_CONDITION_AST');
  });

  it('validates nested branches', () => {
    expect(withWhen({
      op: 'and',
      conditions: [{ op: 'or', conditions: [{ op: 'nope' }] }],
    })).toContain('UNSUPPORTED_CONDITION_OPERATOR');
  });

  it('refuses a condition tree deep enough to be hostile', () => {
    let deep: unknown = { op: 'exists', path: 'ctx.a' };
    for (let level = 0; level < 40; level += 1) {
      deep = { op: 'not', condition: deep };
    }
    expect(withWhen(deep)).toContain('INVALID_CONDITION_AST');
  });
});
