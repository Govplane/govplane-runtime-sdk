import { describe, expect, it } from '@jest/globals';
import { evalWhen } from '../../src/engine/when.js';
import type { WhenAstV1 } from '../../src/engine/types.js';

/**
 * The condition evaluator.
 *
 * Every `when` clause in every rule runs through this, so its behaviour is part
 * of the policy language's contract. It arrived from the 1.x SDK with almost no
 * direct coverage; these tests pin what it actually does, including the parts a
 * policy author would be surprised by.
 */

const ctx = {
  plan: 'pro',
  failedAttempts: 6,
  country: 'ES',
  isAuthenticated: true,
  nothing: null,
  user: { role: 'admin', team: { name: 'core' } },
};

const evaluate = (node: WhenAstV1): boolean => evalWhen(node, ctx);

describe('path resolution', () => {
  it('treats "plan" and "ctx.plan" as the same path', () => {
    expect(evaluate({ op: 'eq', path: 'plan', value: 'pro' })).toBe(true);
    expect(evaluate({ op: 'eq', path: 'ctx.plan', value: 'pro' })).toBe(true);
  });

  it('walks nested objects', () => {
    expect(evaluate({ op: 'eq', path: 'ctx.user.role', value: 'admin' })).toBe(true);
    expect(evaluate({ op: 'eq', path: 'ctx.user.team.name', value: 'core' })).toBe(true);
  });

  it('returns undefined for a path through a missing branch, rather than throwing', () => {
    expect(evaluate({ op: 'exists', path: 'ctx.absent.deeply.nested' })).toBe(false);
  });

  it('stops at a non-object rather than indexing into it', () => {
    expect(evaluate({ op: 'exists', path: 'ctx.plan.length' })).toBe(false);
  });
});

describe('comparison operators', () => {
  it('compares equality strictly', () => {
    expect(evaluate({ op: 'eq', path: 'failedAttempts', value: 6 })).toBe(true);
    // Strict: the string "6" is not the number 6.
    expect(evaluate({ op: 'eq', path: 'failedAttempts', value: '6' as never })).toBe(false);
  });

  it('accepts neq and its legacy spelling ne', () => {
    expect(evaluate({ op: 'neq', path: 'plan', value: 'free' })).toBe(true);
    expect(evaluate({ op: 'ne', path: 'plan', value: 'free' })).toBe(true);
    expect(evaluate({ op: 'neq', path: 'plan', value: 'pro' })).toBe(false);
  });

  const ordering: [op: 'gt' | 'gte' | 'lt' | 'lte', value: number, expected: boolean][] = [
    ['gt', 5, true], ['gt', 6, false], ['gt', 7, false],
    ['gte', 6, true], ['gte', 7, false],
    ['lt', 7, true], ['lt', 6, false],
    ['lte', 6, true], ['lte', 5, false],
  ];

  it.each(ordering)('%s %s → %s', (op, value, expected) => {
    expect(evaluate({ op, path: 'failedAttempts', value })).toBe(expected);
  });

  it('coerces both sides of an ordering comparison to numbers', () => {
    // A numeric string in the context still compares numerically, which is what
    // makes `gte` work against values arriving from headers or query strings.
    expect(evalWhen({ op: 'gte', path: 'n', value: 5 }, { n: '10' })).toBe(true);
  });

  it('is false when an ordering comparison hits a non-numeric value', () => {
    // Number("pro") is NaN, and every comparison with NaN is false.
    expect(evaluate({ op: 'gt', path: 'plan', value: 1 })).toBe(false);
    expect(evaluate({ op: 'lt', path: 'plan', value: 1 })).toBe(false);
  });

  it('is false when the path is missing entirely', () => {
    expect(evaluate({ op: 'eq', path: 'absent', value: 'anything' })).toBe(false);
    expect(evaluate({ op: 'gt', path: 'absent', value: 0 })).toBe(false);
  });
});

describe('exists', () => {
  it('is true for a present value, including falsy ones', () => {
    expect(evalWhen({ op: 'exists', path: 'zero' }, { zero: 0 })).toBe(true);
    expect(evalWhen({ op: 'exists', path: 'empty' }, { empty: '' })).toBe(true);
    expect(evalWhen({ op: 'exists', path: 'no' }, { no: false })).toBe(true);
  });

  it('is false for null and for absent', () => {
    expect(evaluate({ op: 'exists', path: 'nothing' })).toBe(false);
    expect(evaluate({ op: 'exists', path: 'absent' })).toBe(false);
  });
});

describe('in', () => {
  it('matches by strict equality against the list', () => {
    expect(evaluate({ op: 'in', path: 'country', values: ['ES', 'FR'] })).toBe(true);
    expect(evaluate({ op: 'in', path: 'country', values: ['DE'] })).toBe(false);
    expect(evaluate({ op: 'in', path: 'failedAttempts', values: ['6'] })).toBe(false);
  });

  it('is false against an empty list', () => {
    expect(evaluate({ op: 'in', path: 'country', values: [] })).toBe(false);
  });
});

describe('logical operators', () => {
  const yes: WhenAstV1 = { op: 'eq', path: 'plan', value: 'pro' };
  const no: WhenAstV1 = { op: 'eq', path: 'plan', value: 'free' };

  it('and requires every branch', () => {
    expect(evaluate({ op: 'and', conditions: [yes, yes] })).toBe(true);
    expect(evaluate({ op: 'and', conditions: [yes, no] })).toBe(false);
  });

  it('or requires one branch', () => {
    expect(evaluate({ op: 'or', conditions: [no, yes] })).toBe(true);
    expect(evaluate({ op: 'or', conditions: [no, no] })).toBe(false);
  });

  it('not inverts', () => {
    expect(evaluate({ op: 'not', condition: no })).toBe(true);
    expect(evaluate({ op: 'not', condition: yes })).toBe(false);
  });

  it('accepts the legacy args and arg spellings', () => {
    expect(evaluate({ op: 'and', args: [yes, yes] })).toBe(true);
    expect(evaluate({ op: 'or', args: [no, yes] })).toBe(true);
    expect(evaluate({ op: 'not', arg: no })).toBe(true);
  });

  it('treats an empty and as true and an empty or as false', () => {
    // Standard vacuous-truth semantics, and worth pinning: a policy author
    // writing an empty `and` gets a rule that always fires.
    expect(evaluate({ op: 'and', conditions: [] })).toBe(true);
    expect(evaluate({ op: 'or', conditions: [] })).toBe(false);
  });

  it('treats a branchless and/or as empty rather than throwing', () => {
    expect(evaluate({ op: 'and' } as unknown as WhenAstV1)).toBe(true);
    expect(evaluate({ op: 'or' } as unknown as WhenAstV1)).toBe(false);
  });

  it('nests to arbitrary depth', () => {
    expect(evaluate({
      op: 'and',
      conditions: [
        { op: 'or', conditions: [no, { op: 'not', condition: no }] },
        { op: 'gte', path: 'failedAttempts', value: 5 },
        { op: 'in', path: 'country', values: ['ES'] },
      ],
    })).toBe(true);
  });
});

describe('unknown operators', () => {
  it('is false rather than throwing', () => {
    // A bundle written against a newer policy language must not crash an older
    // runtime; the rule simply does not fire.
    expect(evaluate({ op: 'approximately' } as unknown as WhenAstV1)).toBe(false);
  });
});
