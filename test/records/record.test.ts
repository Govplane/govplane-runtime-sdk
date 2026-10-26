import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { buildDecisionRecord } from '../../src/records/record.js';
import type { BuildRecordInput } from '../../src/records/record.js';
import type { BundleSnapshot } from '../../src/records/types.js';

/**
 * Record shape.
 *
 * The shape is a published contract, so it is pinned against a golden fixture:
 * any drift shows up as a diff in review rather than in a customer's parser.
 * The privacy rules are pinned here too — a value appears only for a key that
 * was named, and key names appear regardless.
 */

const SNAPSHOT: BundleSnapshot = {
  version: 7,
  generatedAt: '2026-09-12T09:31:00.000Z',
  checksum: 'sha256:a91f0d0a2b7c1d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e',
  signature: { algorithm: 'ECDSA_SHA_256', verified: true },
  origin: 'local',
};

const TARGET = { service: 'agent', resource: 'send_email', action: 'invoke' };

const base = (): BuildRecordInput => ({
  decision: {
    decision: 'deny', reason: 'rule', policyKey: 'data-handling', ruleId: 'r_pii_export',
  },
  input: { target: TARGET, context: { piiScore: 0.87, injectionScore: 0.04, tenant: 'acme' } },
  snapshot: SNAPSHOT,
  includeContext: ['piiScore', 'tenant'],
  seq: 4211,
  id: '01JGX2W4K8N7QZ3M5Y6P8R9T0A',
  at: '2026-09-14T14:02:11.417Z',
});

describe('buildDecisionRecord', () => {
  it('matches the golden fixture', () => {
    const golden = JSON.parse(
      readFileSync(join(process.cwd(), 'test', 'fixtures', 'records', 'record.v1.json'), 'utf8'),
    );
    expect(buildDecisionRecord(base())).toEqual(golden);
  });

  it('records values only for named keys, and names for every key', () => {
    const record = buildDecisionRecord({ ...base(), includeContext: ['tenant'] });
    expect(record.context).toEqual({ tenant: 'acme' });
    expect(record.contextKeysPresent).toEqual(['piiScore', 'injectionScore', 'tenant']);
  });

  it('omits context entirely when nothing was named', () => {
    const record = buildDecisionRecord({ ...base(), includeContext: [] });
    expect('context' in record).toBe(false);
    expect(record.contextKeysPresent).toEqual(['piiScore', 'injectionScore', 'tenant']);
  });

  it('omits context when the named keys were not supplied', () => {
    const record = buildDecisionRecord({ ...base(), includeContext: ['absent'] });
    expect('context' in record).toBe(false);
  });

  it('never invents a value for a named key that is absent', () => {
    const record = buildDecisionRecord({ ...base(), includeContext: ['tenant', 'absent'] });
    expect(record.context).toEqual({ tenant: 'acme' });
    expect(Object.keys(record.context ?? {})).not.toContain('absent');
  });

  it('carries effect payloads and nothing for effects without one', () => {
    const throttle = { limit: 10, windowSeconds: 60, key: 'ctx.userId' };
    expect(buildDecisionRecord({
      ...base(), decision: { decision: 'throttle', reason: 'rule', throttle },
    })).toMatchObject({ decision: 'throttle', throttle });

    const killSwitch = { service: 'agent', reason: 'incident' };
    expect(buildDecisionRecord({
      ...base(), decision: { decision: 'kill_switch', reason: 'default', killSwitch },
    })).toMatchObject({ killSwitch });

    const approval = { reason: 'PII export', approvers: ['security'] };
    expect(buildDecisionRecord({
      ...base(), decision: { decision: 'requires_approval', reason: 'rule', approval },
    })).toMatchObject({ approval });

    expect(buildDecisionRecord({
      ...base(), decision: { decision: 'custom', reason: 'rule', value: 'v', parsedValue: {} },
    })).toMatchObject({ value: 'v' });

    const allow = buildDecisionRecord({
      ...base(), decision: { decision: 'allow', reason: 'default' },
    });
    expect(allow).not.toHaveProperty('throttle');
    expect(allow).not.toHaveProperty('policyKey');
    expect(allow).not.toHaveProperty('parsedValue');
  });

  it('carries the missing signals of a signal_missing decision', () => {
    expect(buildDecisionRecord({
      ...base(),
      decision: { decision: 'deny', reason: 'signal_missing', missingSignals: ['piiScore'] },
    })).toMatchObject({ reason: 'signal_missing', missingSignals: ['piiScore'] });
  });

  it('describes a rule-addressed evaluation without inventing a target', () => {
    const record = buildDecisionRecord({
      ...base(),
      input: { ruleId: 'r_pii_export', policyKey: 'data-handling', context: { piiScore: 1 } },
    });
    expect(record.ruleAddressed).toEqual({ ruleId: 'r_pii_export', policyKey: 'data-handling' });
    expect('target' in record).toBe(false);
  });

  it('treats a missing context as no keys present', () => {
    const record = buildDecisionRecord({ ...base(), input: { target: TARGET } });
    expect(record.contextKeysPresent).toEqual([]);
    expect('context' in record).toBe(false);
  });
});
