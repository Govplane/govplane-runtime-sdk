import { describe, expect, it } from '@jest/globals';
import { computeChecksum } from '../../src/bundle/canonical.js';
import { createClient } from '../../src/client/GovplaneClient.js';
import { verifyBundle } from '../../src/verify/verifyBundle.js';
import { verifyRecordChain } from '../../src/records/chain.js';
import type { RuntimeBundle } from '../../src/bundle/types.js';
import type { BundleSource, LoadedBundle } from '../../src/source/types.js';
import type { DecisionRecord } from '../../src/records/types.js';
import type { Decision } from '../../src/engine/types.js';

/**
 * Decision records through the client.
 *
 * The property that matters most is the one a reload can break: a record must
 * carry the checksum of the bundle that actually answered, on either side of
 * a change. Beyond that — records are off unless configured, a sink cannot
 * affect a decision, and every shape of `evaluate` records the full decision.
 */

const TARGET = { service: 'auth', resource: 'login', action: 'authenticate' };

const bundleAt = (version: number, denyAt = 5): RuntimeBundle => ({
  schemaVersion: 1,
  env: 'prod',
  generatedAt: `2026-08-0${version}T00:00:00.000Z`,
  bundleVersion: version,
  policies: [{
    policyKey: 'login-protection',
    activeVersion: 1,
    defaults: { effect: 'allow' },
    rules: [{
      id: 'deny-after-five',
      status: 'active',
      priority: 100,
      target: TARGET,
      when: { op: 'gte', path: 'ctx.failedAttempts', value: denyAt },
      effect: { type: 'deny' },
    }],
  }],
});

const load = (bundle: RuntimeBundle): LoadedBundle => ({
  bundle,
  verification: verifyBundle(bundle, { origin: 'local', allowUnsigned: true }),
  unchanged: false,
});

/** A source driven by hand: `change()` is what a watcher or poller would call. */
const fakeSource = (initial: RuntimeBundle) => {
  let onChange: ((loaded: LoadedBundle) => void) | undefined;
  let next = initial;
  const source: BundleSource = {
    origin: 'local',
    load: async () => load(next),
    start: (handlers) => { onChange = handlers.onChange; },
    stop: () => {},
    describe: () => ({ origin: 'local', location: '/tmp/bundle.json' }),
  };
  return {
    source,
    initial: load(initial),
    change: (bundle: RuntimeBundle) => { next = bundle; onChange?.(load(bundle)); },
  };
};

const collect = () => {
  const records: DecisionRecord[] = [];
  const errors: unknown[] = [];
  return {
    records,
    errors,
    sink: (batch: DecisionRecord[]) => { records.push(...batch); },
    onError: (error: unknown) => { errors.push(error); },
  };
};

describe('off by default', () => {
  it('reports disabled with zero counters and records nothing', () => {
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial);
    client.evaluate({ target: TARGET, context: { failedAttempts: 9 } });
    expect(client.status().records).toEqual({
      enabled: false, queued: 0, emitted: 0, dropped: 0, lastError: null,
    });
    client.close();
  });

  it('flushRecords resolves immediately', async () => {
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial);
    await expect(client.flushRecords()).resolves.toBeUndefined();
  });
});

describe('what a record says about its bundle', () => {
  it('uses the embedded checksum, or computes one when there is none', async () => {
    const out = collect();
    const bare = bundleAt(1);
    const { source, initial } = fakeSource(bare);
    const client = createClient(source, initial, { record: { sink: out.sink } });
    client.evaluate({ target: TARGET, context: { failedAttempts: 9 } });
    await client.flushRecords();
    expect(out.records[0]?.bundle).toEqual({
      version: 1,
      generatedAt: '2026-08-01T00:00:00.000Z',
      checksum: computeChecksum(bare),
      signature: { verified: false },
      origin: 'local',
    });

    const embedded = computeChecksum(bundleAt(2));
    const second = fakeSource({ ...bundleAt(2), checksum: embedded });
    const other = createClient(second.source, second.initial, { record: { sink: out.sink } });
    other.evaluate({ target: TARGET, context: { failedAttempts: 9 } });
    await other.flushRecords();
    expect(other.status().checksum).toBe(embedded);
    expect(out.records[1]?.bundle.checksum).toBe(embedded);
  });

  it('carries the right checksum on each side of a reload', async () => {
    const out = collect();
    const v1 = bundleAt(1);
    const v2 = bundleAt(2);
    const { source, initial, change } = fakeSource(v1);
    const client = createClient(source, initial, { record: { sink: out.sink } });

    client.evaluate({ target: TARGET, context: { failedAttempts: 9 } });
    change(v2);
    client.evaluate({ target: TARGET, context: { failedAttempts: 9 } });
    await client.reload();
    client.evaluate({ target: TARGET, context: { failedAttempts: 9 } });
    await client.flushRecords();

    expect(out.records.map((r) => [r.bundle.version, r.bundle.checksum])).toEqual([
      [1, computeChecksum(v1)],
      [2, computeChecksum(v2)],
      [2, computeChecksum(v2)],
    ]);
    expect(out.records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });
});

describe('every way in records the whole decision', () => {
  it('records the full decision behind a shaped answer', async () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, { record: { sink: out.sink } });

    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 9 } }, { asBoolean: true }))
      .toBe(false);
    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 9 } }, { asBinary: true }))
      .toBe(0);
    expect(client.evaluate(
      { target: TARGET, context: { failedAttempts: 1 } },
      { effectOnly: true },
    )).toBe('allow');
    await client.flushRecords();

    expect(out.records.map((r) => [r.decision, r.reason, r.ruleId])).toEqual([
      ['deny', 'rule', 'deny-after-five'],
      ['deny', 'rule', 'deny-after-five'],
      ['allow', 'default', undefined],
    ]);
  });

  it('still refuses conflicting shape options', () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, { record: { sink: out.sink } });
    expect(() => client.evaluate(
      { target: TARGET },
      { asBoolean: true, asBinary: true } as never,
    )).toThrow(/INVALID_EVALUATE_OPTIONS|one of/);
  });

  it('records one record per evaluateWithTrace call', async () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, { record: { sink: out.sink } });
    client.evaluateWithTrace(
      { target: TARGET, context: { failedAttempts: 9 } },
      { level: 'full', force: true },
    );
    await client.flushRecords();
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).not.toHaveProperty('trace');
  });

  it('records a rule addressed by name', async () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, { record: { sink: out.sink } });
    client.evaluate({ ruleId: 'deny-after-five', context: { failedAttempts: 9 } });
    await client.flushRecords();
    expect(out.records[0]).toMatchObject({
      ruleAddressed: { ruleId: 'deny-after-five' }, decision: 'deny',
    });
    expect(out.records[0]).not.toHaveProperty('target');
  });

  it('records a signal_missing decision with its signals', async () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, {
      engine: { signals: { required: ['riskScore'] } },
      record: { sink: out.sink },
    });
    client.evaluate({ target: TARGET, context: { failedAttempts: 9 } });
    await client.flushRecords();
    expect(out.records[0]).toMatchObject({
      decision: 'deny', reason: 'signal_missing', missingSignals: ['riskScore'],
    });
  });
});

describe('privacy', () => {
  it('records named context values only, and names for the rest', async () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, {
      record: { sink: out.sink, include: { context: ['tenant'] } },
    });
    client.evaluate({ target: TARGET, context: { failedAttempts: 9, tenant: 'acme' } });
    await client.flushRecords();
    expect(out.records[0]?.context).toEqual({ tenant: 'acme' });
    expect(out.records[0]?.contextKeysPresent).toEqual(['failedAttempts', 'tenant']);
    expect(JSON.stringify(out.records[0])).not.toContain('"failedAttempts":9');
  });

  it('refuses to be built when a named key looks like PII', () => {
    const { source, initial } = fakeSource(bundleAt(1));
    expect(() => createClient(source, initial, {
      engine: { contextPolicy: { allowedKeys: ['email', 'failedAttempts'] } },
      record: { sink: () => {}, include: { context: ['email'] } },
    })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
  });
});

describe('the sink cannot touch the decision', () => {
  it('reports a failing sink through onError with a code', async () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, {
      onError: out.onError,
      record: { sink: () => { throw new Error('nope'); } },
    });
    const decision: Decision = client.evaluate({ target: TARGET, context: { failedAttempts: 9 } });
    expect(decision).toMatchObject({ decision: 'deny', reason: 'rule' });
    await client.flushRecords();
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ code: 'RECORD_SINK_ERROR' });
    expect(client.status().records).toMatchObject({
      emitted: 0, dropped: 1, lastError: { code: 'RECORD_SINK_ERROR' },
    });
  });

  it('counts records in status', async () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, { record: { sink: out.sink } });
    client.evaluate({ target: TARGET });
    expect(client.status().records).toMatchObject({ enabled: true, queued: 1, emitted: 0 });
    await client.flushRecords();
    expect(client.status().records).toMatchObject({ enabled: true, queued: 0, emitted: 1 });
  });
});

describe('chain', () => {
  it('produces a verifiable sequence', async () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, { record: { sink: out.sink, chain: true } });
    for (let i = 0; i < 12; i += 1) {
      client.evaluate({ target: TARGET, context: { failedAttempts: i } });
    }
    await client.flushRecords();
    expect(verifyRecordChain(out.records)).toEqual({ ok: true, records: 12 });
  });
});

describe('close', () => {
  it('is synchronous and still delivers what was queued', async () => {
    const out = collect();
    const { source, initial } = fakeSource(bundleAt(1));
    const client = createClient(source, initial, {
      record: { sink: out.sink, batch: { maxDelayMs: 60_000 } },
    });
    client.evaluate({ target: TARGET });
    expect(client.close()).toBeUndefined();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(out.records).toHaveLength(1);
  });
});
