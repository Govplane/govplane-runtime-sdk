import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { canonicalPayload } from '../../src/bundle/canonical.js';
import { createRemoteClient } from '../../src/client/createRemoteClient.js';
import type { RuntimeBundle } from '../../src/bundle/types.js';

/**
 * End-to-end through the real client: configure `observe`, evaluate, flush, and
 * check what reaches the wire.
 *
 * The unit tests cover the aggregator and the transport separately. This one
 * exists for the wiring between them, which is where a telemetry feature
 * usually fails — quietly, by counting nothing.
 */

const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PUBLIC_KEY = ecdsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const bundle = (): RuntimeBundle => ({
  schemaVersion: 1,
  orgId: 'org_1',
  projectId: 'proj_1',
  env: 'prod',
  generatedAt: '2026-08-02T00:00:00.000Z',
  bundleVersion: 3,
  policies: [{
    policyKey: 'login-protection',
    activeVersion: 1,
    defaults: { effect: 'allow' },
    rules: [{
      id: 'deny-after-five',
      status: 'active',
      priority: 100,
      target: { service: 'auth', resource: 'login', action: 'authenticate' },
      when: { op: 'gte', path: 'ctx.failedAttempts', value: 5 },
      effect: { type: 'deny' },
    }],
  }],
});

const signed = (): RuntimeBundle => {
  const target = bundle();
  const signer = createSign('SHA256');
  signer.update(canonicalPayload(target));
  return {
    ...target,
    signature: {
      algorithm: 'ECDSA_SHA_256',
      keyId: 'cloud-key',
      value: signer.sign(ecdsa.privateKey).toString('base64'),
    },
  };
};

interface Ingested {
  url: string;
  body: { env: string; points?: Point[]; entries?: LogEntry[] };
}
interface LogEntry { message: string; level: string; traceId?: string; code?: string }
interface Point { name: string; value: number; category: string; tags: Record<string, string> }

/** Serves the bundle on the bundle host and records anything sent to ingest. */
const harness = () => {
  const ingested: Ingested[] = [];

  const impl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('ingest')) {
      ingested.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('', { status: 202 });
    }
    return new Response(JSON.stringify(signed()), { status: 200 });
  }) as unknown as typeof fetch;

  return { impl, ingested };
};

const BASE = {
  baseUrl: 'https://runtime.example.com/v1/bundle',
  runtimeKey: 'rk_test',
  orgId: 'org_1',
  projectId: 'proj_1',
  env: 'prod',
  verify: { algorithm: 'ECDSA_SHA_256' as const, publicKey: PUBLIC_KEY },
};

const deny = {
  target: { service: 'auth', resource: 'login', action: 'authenticate' },
  context: { failedAttempts: 9 },
};
const allow = { ...deny, context: { failedAttempts: 1 } };

describe('a client without observe is unchanged', () => {
  it('exposes no observer and sends nothing to ingest', async () => {
    const { impl, ingested } = harness();
    const client = await createRemoteClient({ ...BASE, fetchImpl: impl });

    expect(client.evaluate(deny).decision).toBe('deny');
    expect(client.observe).toBeUndefined();
    expect(ingested).toHaveLength(0);
  });
});

describe('a client with observe', () => {
  const observed = async () => {
    const { impl, ingested } = harness();
    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      observe: {
        endpoint: 'https://abc.ingest.govplane.com',
        source: 'auth-api',
        enabled: true,
        ingestDecisionTracing: true,
        ingestCustomMetrics: true,
      },
    });
    return { client, ingested };
  };

  it('still returns the same decisions', async () => {
    // The point of the whole design: telemetry observes, it does not alter.
    const { client } = await observed();
    expect(client.evaluate(deny).decision).toBe('deny');
    expect(client.evaluate(allow).decision).toBe('allow');
  });

  it('counts decisions made through plain evaluate()', async () => {
    // The reason counting hangs off `onDecision` rather than the trace sink:
    // `evaluate()` emits no traces at all, so a trace-based counter would report
    // zero here while looking perfectly healthy.
    const { client, ingested } = await observed();
    for (let i = 0; i < 5; i += 1) client.evaluate(deny);
    await client.observe?.flush();

    const points = ingested.flatMap((r) => r.body.points ?? []);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ name: 'gp.policy.decisions', value: 5 });
  });

  it('counts every decision rather than a sample of them', async () => {
    // Traces are sampled at 1% under a 60/min budget. A count taken from them
    // would be wrong by orders of magnitude.
    const { client, ingested } = await observed();
    for (let i = 0; i < 1000; i += 1) client.evaluate(allow);
    await client.observe?.flush();

    const total = ingested
      .flatMap((r) => r.body.points ?? [])
      .reduce((sum, p) => sum + p.value, 0);
    expect(total).toBe(1000);
  });

  it('separates outcomes and attributes them to the deciding rule', async () => {
    const { client, ingested } = await observed();
    client.evaluate(deny);
    client.evaluate(allow);
    client.evaluate(allow);
    await client.observe?.flush();

    const points = ingested.flatMap((r) => r.body.points ?? []);
    const denied = points.find((p) => p.tags.decision === 'deny');
    expect(denied).toMatchObject({ value: 1 });
    expect(denied?.tags).toMatchObject({
      policyKey: 'login-protection', ruleId: 'deny-after-five',
    });
  });

  it('tags decisions with the bundle version that produced them', async () => {
    // What makes a publish watch an exact comparison rather than a guess about
    // when instances finished migrating.
    const { client, ingested } = await observed();
    client.evaluate(deny);
    await client.observe?.flush();

    expect(ingested[0]?.body.points?.[0]?.tags.bundleVersion).toBe('3');
  });

  it('posts to the ingest host, not the bundle host', async () => {
    const { client, ingested } = await observed();
    client.evaluate(deny);
    await client.observe?.flush();

    expect(ingested[0]?.url).toBe('https://abc.ingest.govplane.com/v1/proj_1/prod/metrics');
  });

  it('counts decisions made through evaluateWithTrace() too', async () => {
    const { client, ingested } = await observed();
    client.evaluateWithTrace(deny, { level: 'off' });
    await client.observe?.flush();

    expect(ingested.flatMap((r) => r.body.points ?? [])).toHaveLength(1);
  });

  it('counts a shaped evaluate, where the decision object is discarded', async () => {
    // `evaluate(input, { asBoolean: true })` returns a boolean, so policyKey and
    // ruleId are gone by the time the caller sees it. Hooking the engine rather
    // than wrapping the client is what keeps this attributable.
    const { client, ingested } = await observed();
    expect(client.evaluate(deny, { asBoolean: true })).toBe(false);
    await client.observe?.flush();

    const point = ingested.flatMap((r) => r.body.points ?? [])[0];
    expect(point?.tags).toMatchObject({ ruleId: 'deny-after-five' });
  });
});

describe('custom application metrics', () => {
  const observed = async () => {
    const { impl, ingested } = harness();
    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      observe: {
        endpoint: 'https://abc.ingest.govplane.com',
        source: 'auth-api',
        enabled: true,
        ingestDecisionTracing: true,
        ingestCustomMetrics: true,
      },
    });
    return { client, ingested };
  };

  it('ships a business event alongside decision counters', async () => {
    // The half that makes decision telemetry actionable: "rule X denied 12% of
    // checkouts" is a curiosity until you can see payments failing next to it.
    const { client, ingested } = await observed();
    client.evaluate(deny);
    client.observe?.event('payment.failed', {
      category: 'error_rate',
      tags: { provider: 'stripe' },
    });
    await client.observe?.flush();

    const points = ingested.flatMap((r) => r.body.points ?? []);
    const names = points.map((p) => p.name);
    expect(names).toContain('gp.policy.decisions');
    expect(names).toContain('payment.failed');
  });

  it('sends both in one request rather than two', async () => {
    // They share a bucket boundary, so splitting them would double the round
    // trips and the idempotency keys for nothing.
    const { client, ingested } = await observed();
    client.evaluate(deny);
    client.observe?.event('payment.failed');
    await client.observe?.flush();

    expect(ingested).toHaveLength(1);
  });

  it('sums events over the interval', async () => {
    const { client, ingested } = await observed();
    for (let i = 0; i < 40; i += 1) client.observe?.event('payment.failed');
    await client.observe?.flush();

    const point = ingested.flatMap((r) => r.body.points ?? [])
      .find((p) => p.name === 'payment.failed');
    expect(point?.value).toBe(40);
  });

  it('records a measurement', async () => {
    const { client, ingested } = await observed();
    client.observe?.metric('checkout.queue_depth', 128, { unit: 'count' });
    await client.observe?.flush();

    const point = ingested.flatMap((r) => r.body.points ?? [])
      .find((p) => p.name === 'checkout.queue_depth');
    expect(point?.value).toBe(128);
  });

  it('a malformed custom metric does not discard the decision counters', async () => {
    // The reason validation is client-side: gp-data validates a batch
    // all-or-nothing, so one bad point would erase the decisions travelling
    // with it.
    const errors: unknown[] = [];
    const { impl, ingested } = harness();
    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      observe: {
        endpoint: 'https://abc.ingest.govplane.com',
        onError: (e) => errors.push(e),
        enabled: true,
        ingestDecisionTracing: true,
        ingestCustomMetrics: true,
      },
    });

    client.evaluate(deny);
    client.observe?.metric('broken', Number.NaN);
    await client.observe?.flush();

    const points = ingested.flatMap((r) => r.body.points ?? []);
    expect(points.map((p) => p.name)).toEqual(['gp.policy.decisions']);
    expect(errors).toHaveLength(1);
  });
});

describe('correlated records', () => {
  const observed = async () => {
    const { impl, ingested } = harness();
    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      observe: {
        endpoint: 'https://abc.ingest.govplane.com',
        source: 'auth-api',
        enabled: true,
        ingestDecisionTracing: true,
        ingestCustomMetrics: true,
      },
    });
    return { client, ingested };
  };

  it('posts to the log path, not the metric path', async () => {
    const { client, ingested } = await observed();
    client.observe?.record('payment declined', { code: 'card_declined' });
    await client.observe?.flush();

    expect(ingested[0]?.url).toBe('https://abc.ingest.govplane.com/v1/proj_1/prod/logs');
  });

  it('carries the traceId of the decision it followed from', async () => {
    // The join an aggregated metric cannot express: a trace id is
    // high-cardinality, so it can never be a tag.
    const { client, ingested } = await observed();
    const { trace } = client.evaluateWithTrace(deny, { level: 'full', force: true });
    client.observe?.record('payment declined', { traceId: trace?.traceId, level: 'error' });
    await client.observe?.flush();

    const entries = ingested.flatMap((r) => r.body.entries ?? []);
    expect(entries[0]?.traceId).toBe(trace?.traceId);
    expect(entries[0]?.level).toBe('error');
  });

  it('travels in its own request, sent before the metrics', async () => {
    // A separate endpoint means a separate request either way; sending records
    // first means that if the metric batch is what exhausts the quota, the
    // records explaining it have already landed.
    const { client, ingested } = await observed();
    client.evaluate(deny);
    client.observe?.record('something happened');
    await client.observe?.flush();

    expect(ingested).toHaveLength(2);
    expect(ingested[0]?.url).toMatch(/\/logs$/);
    expect(ingested[1]?.url).toMatch(/\/metrics$/);
  });

  it('does not aggregate: five calls are five records', async () => {
    const { client, ingested } = await observed();
    for (let i = 0; i < 5; i += 1) client.observe?.record('same message');
    await client.observe?.flush();

    expect(ingested.flatMap((r) => r.body.entries ?? [])).toHaveLength(5);
  });
});

describe('the caller keeps their own hooks', () => {
  it('does not displace a caller-supplied onDecision', async () => {
    const { impl } = harness();
    const seen: string[] = [];

    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      onDecision: (d) => seen.push(d.decision),
      observe: {
        endpoint: 'https://abc.ingest.govplane.com',
        enabled: true,
        ingestDecisionTracing: true,
      },
    });

    client.evaluate(deny);
    expect(seen).toEqual(['deny']);
    expect(client.observe?.pending()).toBe(1);
  });
});

describe('telemetry failure never reaches the application', () => {
  it('keeps evaluating when ingest is unreachable', async () => {
    const impl = (async (url: string) => {
      if (String(url).includes('ingest')) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify(signed()), { status: 200 });
    }) as unknown as typeof fetch;

    const errors: unknown[] = [];
    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      observe: {
        endpoint: 'https://abc.ingest.govplane.com',
        onError: (e) => errors.push(e),
        enabled: true,
        ingestDecisionTracing: true,
        ingestCustomMetrics: true,
      },
    });

    client.evaluate(deny);
    await expect(client.observe?.flush()).resolves.toBeUndefined();
    expect(client.evaluate(deny).decision).toBe('deny');
    expect(errors.length).toBeGreaterThan(0);
  });
});

/**
 * The switches, exercised through the real client rather than the resolver.
 *
 * The resolver's own tests prove what the config means; these prove the meaning
 * reaches the wire. A telemetry feature fails quietly by definition — the
 * failure is an absence — so the assertions here are mostly about what is
 * *not* sent.
 */
describe('turning ingestion on by category', () => {
  const build = async (observe: Record<string, unknown>) => {
    const { impl, ingested } = harness();
    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      observe: {
        endpoint: 'https://abc.ingest.govplane.com',
        source: 'auth-api',
        enabled: true,
        ...observe,
      },
    });
    return { client, ingested };
  };

  const points = (ingested: Ingested[]) => ingested.flatMap((r) => r.body.points ?? []);

  it('sends nothing at all when the master switch is off', async () => {
    const { client, ingested } = await build({
      enabled: false,
      ingestDecisionTracing: true,
      ingestCustomMetrics: true,
    });

    client.evaluate(deny);
    client.observe?.event('checkout.completed');
    await client.observe?.flush();

    expect(ingested).toHaveLength(0);
  });

  it('leaves no observer to call when the master switch is off', async () => {
    // The same client you get with no `observe` block at all, which is what
    // makes the switch a genuine kill switch rather than a filter.
    const { client } = await build({ enabled: false });

    expect(client.observe).toBeUndefined();
  });

  it('counts decisions when decision tracing is on', async () => {
    const { client, ingested } = await build({ enabled: true, ingestDecisionTracing: true });

    for (let i = 0; i < 3; i += 1) client.evaluate(deny);
    await client.observe?.flush();

    expect(points(ingested)).toHaveLength(1);
    expect(points(ingested)[0]?.value).toBe(3);
  });

  it('counts nothing when decision tracing is off', async () => {
    const { client, ingested } = await build({ enabled: true, ingestCustomMetrics: true });

    for (let i = 0; i < 3; i += 1) client.evaluate(deny);
    await client.observe?.flush();

    expect(points(ingested)).toHaveLength(0);
  });

  it('still evaluates identically with every category off', async () => {
    // The invariant the whole module is built around. Ingestion configuration
    // is not allowed to be an input to a policy decision.
    const { client } = await build({ enabled: true });

    expect(client.evaluate(deny).decision).toBe('deny');
    expect(client.evaluate(allow).decision).toBe('allow');
  });

  it('sends custom metrics when custom metrics are on', async () => {
    const { client, ingested } = await build({ enabled: true, ingestCustomMetrics: true });

    client.observe?.event('checkout.completed');
    await client.observe?.flush();

    expect(points(ingested).map((p) => p.name)).toContain('checkout.completed');
  });

  it('keeps a caller-supplied onDecision working when tracing is off', async () => {
    /**
     * The hook is not registered with the engine when decision tracing is off,
     * and the caller's own hook has to survive that. Vendor-neutral use of
     * `onDecision` — a StatsD counter, a log line — must not depend on whether
     * Govplane ingestion happens to be enabled.
     */
    const seen: string[] = [];
    const { impl } = harness();
    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      onDecision: (d) => { seen.push(d.decision); },
      observe: {
        endpoint: 'https://abc.ingest.govplane.com',
        enabled: true,
        ingestCustomMetrics: true,
      },
    });

    client.evaluate(deny);

    expect(seen).toEqual(['deny']);
  });
});

describe('using a stream that was not enabled', () => {
  const build = async (observe: Record<string, unknown>) => {
    const { impl, ingested } = harness();
    const errors: unknown[] = [];
    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      observe: {
        endpoint: 'https://abc.ingest.govplane.com',
        onError: (e: unknown) => { errors.push(e); },
        enabled: true,
        ...observe,
      },
    });
    return { client, ingested, errors };
  };

  it('does not throw into the application', async () => {
    /**
     * The one thing this module may never do. `client.observe` stays defined
     * and its methods stay callable; leaving them off would turn a
     * configuration mistake into a TypeError inside a request handler.
     */
    const { client } = await build({ enabled: true, ingestDecisionTracing: true });

    expect(() => client.observe?.event('checkout.completed')).not.toThrow();
    expect(() => client.observe?.metric('queue_depth', 4)).not.toThrow();
    expect(() => client.observe?.record('something happened')).not.toThrow();
  });

  it('says so, rather than accepting the call and dropping it', async () => {
    const { client, errors } = await build({ enabled: true, ingestDecisionTracing: true });

    client.observe?.event('checkout.completed');

    expect(String((errors[0] as Error).message)).toMatch(/custom metrics are not enabled/);
    expect(String((errors[0] as Error).message)).toMatch(/ingestCustomMetrics/);
  });

  it('says it once per method, not once per call', async () => {
    // `event` is designed to be called at request rate. A warning per call
    // would be a worse outage than the one it reports.
    const { client, errors } = await build({ enabled: true, ingestDecisionTracing: true });

    for (let i = 0; i < 100; i += 1) client.observe?.event('checkout.completed');
    for (let i = 0; i < 100; i += 1) client.observe?.metric('queue_depth', i);

    expect(errors).toHaveLength(2);
  });

  it('warns when ingestion is on and no category is', async () => {
    const { errors } = await build({ enabled: true });

    expect(String((errors[0] as Error).message)).toMatch(/no category is/);
  });

  it('does not warn when ingestion is deliberately off', async () => {
    // `enabled: false` is a decision, not a mistake. The "nothing is enabled"
    // warning exists for somebody who meant to send something and will
    // otherwise find out from an empty dashboard.
    const { errors } = await build({ enabled: false });

    expect(errors).toHaveLength(0);
  });
});
