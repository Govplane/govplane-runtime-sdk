import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import { createLocalClient } from '../../src/client/createLocalClient.js';
import { RuleNotFoundError } from '../../src/errors/errors.js';
import { computeChecksum } from '../../src/bundle/canonical.js';
import type { GovplaneClient } from '../../src/client/GovplaneClient.js';
import type { RuntimeBundle } from '../../src/bundle/types.js';
import type { Decision } from '../../src/engine/types.js';

/**
 * The v2.1 evaluation options reaching a real client.
 *
 * The engine tests cover the semantics; these cover the wiring — that the second
 * argument survives the client boundary, and that the overloads narrow the
 * return type instead of handing back a union.
 */

const TARGET = { service: 'auth', resource: 'login', action: 'authenticate' };

const bundle = (): RuntimeBundle => {
  const base = {
    schemaVersion: 1,
    env: 'prod',
    generatedAt: '2026-08-06T00:00:00.000Z',
    bundleVersion: 1,
    policies: [{
      policyKey: 'login-protection',
      activeVersion: 1,
      defaults: { effect: 'allow' },
      rules: [{
        id: 'deny-after-five',
        status: 'active',
        priority: 100,
        target: TARGET,
        when: { op: 'gte', path: 'ctx.failedAttempts', value: 5 },
        effect: { type: 'deny' },
      }],
    }],
  } as unknown as RuntimeBundle;

  return { ...base, checksum: computeChecksum(base) };
};

describe('evaluate options through a client', () => {
  let root: string;
  let bundlePath: string;
  let client: GovplaneClient;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'govplane-sdk-eval-'));
    bundlePath = join(root, 'policy-bundle.json');
    writeFileSync(bundlePath, JSON.stringify(bundle()));
    client = await createLocalClient({ bundlePath, allowUnsigned: true });
  });

  afterEach(() => {
    client.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the full decision by default', () => {
    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 6 } }))
      .toMatchObject({ decision: 'deny', reason: 'rule', ruleId: 'deny-after-five' });
  });

  it('reduces to a boolean', () => {
    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 6 } }, { asBoolean: true }))
      .toBe(false);
    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 1 } }, { asBoolean: true }))
      .toBe(true);
  });

  it('reduces to a bit', () => {
    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 6 } }, { asBinary: true }))
      .toBe(0);
  });

  it('reduces to the effect name', () => {
    const shaped = client.evaluate(
      { target: TARGET, context: { failedAttempts: 6 } },
      { effectOnly: true },
    );
    expect(shaped).toBe('deny');
  });

  it('evaluates a rule by id', () => {
    expect(client.evaluate({ ruleId: 'deny-after-five', context: { failedAttempts: 6 } }))
      .toMatchObject({ decision: 'deny', ruleId: 'deny-after-five' });
  });

  it('throws through the client for an unknown rule', () => {
    expect(() => client.evaluate({ ruleId: 'nope' })).toThrow(RuleNotFoundError);
  });

  it('combines a rule id with a return shape', () => {
    const shaped = client.evaluate(
      { ruleId: 'deny-after-five', context: { failedAttempts: 1 } },
      { asBoolean: true },
    );
    expect(shaped).toBe(true);
  });

  /**
   * Compile-time, not run-time: each assignment fails `tsc` if an overload stops
   * narrowing and hands back the union instead.
   */
  it('narrows the return type per option', () => {
    const full: Decision = client.evaluate({ target: TARGET });
    const flag: boolean = client.evaluate({ target: TARGET }, { asBoolean: true });
    const bit: 0 | 1 = client.evaluate({ target: TARGET }, { asBinary: true });
    const name: Decision['decision'] = client.evaluate({ target: TARGET }, { effectOnly: true });

    expect(full.decision).toBe('allow');
    expect(flag).toBe(true);
    expect(bit).toBe(1);
    expect(name).toBe('allow');
  });
});
