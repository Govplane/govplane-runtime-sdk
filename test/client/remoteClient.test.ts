import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { canonicalPayload } from '../../src/bundle/canonical.js';
import { createRemoteClient } from '../../src/client/createRemoteClient.js';
import { RemoteBundleSource } from '../../src/source/RemoteBundleSource.js';
import type { RuntimeBundle } from '../../src/bundle/types.js';

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

const signEcdsa = (target: RuntimeBundle): RuntimeBundle => {
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

interface StubOptions {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  fail?: boolean;
}

const stubFetch = (responses: StubOptions[]): { impl: typeof fetch; calls: Request[] } => {
  const calls: Request[] = [];
  let index = 0;

  const impl = (async (url: string, init?: RequestInit) => {
    calls.push(new Request(url, init));
    const spec = responses[Math.min(index, responses.length - 1)] as StubOptions;
    index += 1;

    if (spec.fail === true) {
      throw new Error('network unreachable');
    }

    // `new Response()` refuses to construct a 304 — it is a status only a real
    // network stack may produce. A response-shaped object stands in for it.
    if (spec.status === 304) {
      return {
        status: 304,
        ok: false,
        headers: new Headers(spec.headers ?? {}),
        text: async () => '',
      };
    }

    return new Response(
      spec.body === undefined ? '' : JSON.stringify(spec.body),
      {
        status: spec.status ?? 200,
        headers: spec.headers ?? {},
      },
    );
  }) as unknown as typeof fetch;

  return { impl, calls };
};

const BASE = {
  baseUrl: 'https://runtime.example.com/v1/bundle',
  runtimeKey: 'rk_test',
  orgId: 'org_1',
  projectId: 'proj_1',
  env: 'prod',
  verify: { algorithm: 'ECDSA_SHA_256' as const, publicKey: PUBLIC_KEY },
};

const TARGET = { service: 'auth', resource: 'login', action: 'authenticate' };

describe('createRemoteClient', () => {
  it('fetches, verifies and evaluates', async () => {
    const { impl } = stubFetch([{ body: signEcdsa(bundle()), headers: { etag: '"abc"' } }]);
    const client = await createRemoteClient({ ...BASE, fetchImpl: impl });

    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 6 } }).decision)
      .toBe('deny');
    expect(client.status()).toMatchObject({
      origin: 'remote',
      signature: { status: 'verified', algorithm: 'ECDSA_SHA_256' },
    });
    client.close();
  });

  it('forwards record and onDecision to the client', async () => {
    const { impl } = stubFetch([{ body: signEcdsa(bundle()), headers: { etag: '"abc"' } }]);
    const seen: string[] = [];
    const records: unknown[] = [];
    const client = await createRemoteClient({
      ...BASE,
      fetchImpl: impl,
      onDecision: (d) => { seen.push(d.decision); },
      record: { sink: (batch) => { records.push(...batch); } },
    });

    client.evaluate({ target: TARGET, context: { failedAttempts: 6 } });
    await client.flushRecords();
    expect(seen).toEqual(['deny']);
    expect(records).toHaveLength(1);
    expect(records[0])
      .toMatchObject({ bundle: { origin: 'remote', signature: { verified: true } } });
    expect(client.status().records).toMatchObject({ enabled: true, emitted: 1 });
    client.close();
  });

  it('sends the runtime key and scope', async () => {
    const { impl, calls } = stubFetch([{ body: signEcdsa(bundle()) }]);
    const client = await createRemoteClient({ ...BASE, fetchImpl: impl });

    const request = calls[0] as Request;
    expect(request.headers.get('Authorization')).toBe('rk_test');
    const url = new URL(request.url);
    expect(url.searchParams.get('orgId')).toBe('org_1');
    expect(url.searchParams.get('projectId')).toBe('proj_1');
    expect(url.searchParams.get('env')).toBe('prod');
    client.close();
  });

  it('reads a bundle wrapped in a data envelope', async () => {
    const { impl } = stubFetch([{ body: { success: true, data: { body: signEcdsa(bundle()) } } }]);
    const client = await createRemoteClient({ ...BASE, fetchImpl: impl });
    expect(client.status().policies).toBe(1);
    client.close();
  });

  it('revalidates with If-None-Match once it has an ETag', async () => {
    const { impl, calls } = stubFetch([
      { body: signEcdsa(bundle()), headers: { etag: '"v3"' } },
      { status: 304 },
    ]);

    const client = await createRemoteClient({ ...BASE, fetchImpl: impl });
    await expect(client.reload()).rejects.toMatchObject({ code: 'BUNDLE_NOT_MODIFIED' });

    expect((calls[1] as Request).headers.get('If-None-Match')).toBe('"v3"');
    client.close();
  });

  it('refuses an HMAC-signed bundle from the cloud', async () => {
    // The FIPS boundary, enforced at the point it matters.
    const target = bundle();
    const hmacSigned = {
      ...target,
      signature: {
        algorithm: 'HMAC_SHA256',
        keyId: 'k',
        value: createHmac('sha256', Buffer.from('a'.repeat(64), 'hex'))
          .update(canonicalPayload(target))
          .digest('hex'),
      },
    };
    const { impl } = stubFetch([{ body: hmacSigned }]);

    await expect(createRemoteClient({ ...BASE, fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'BUNDLE_SIGNATURE_ALGORITHM_UNSUPPORTED' });
  });

  it('requires scope fields a local client does not', async () => {
    const { impl } = stubFetch([{ body: signEcdsa(bundle()) }]);

    await expect(createRemoteClient({
      ...BASE, orgId: '', fetchImpl: impl,
    })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  });

  it('names createLocalClient when configuration is missing', async () => {
    await expect(createRemoteClient({} as never))
      .rejects.toThrow('createLocalClient');
  });

  it('refuses to start without a verification key', async () => {
    const { impl } = stubFetch([{ body: signEcdsa(bundle()) }]);
    await expect(createRemoteClient({
      ...BASE, verify: undefined, fetchImpl: impl,
    })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  });

  it('surfaces an HTTP failure', async () => {
    const { impl } = stubFetch([{ status: 503 }]);
    await expect(createRemoteClient({ ...BASE, fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'HTTP_ERROR', status: 503 });
  });

  it('reports malformed JSON from the service', async () => {
    const impl = (async () => new Response('{ broken', { status: 200 })) as unknown as typeof fetch;
    await expect(createRemoteClient({ ...BASE, fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'BUNDLE_PARSE_ERROR' });
  });
});

describe('RemoteBundleSource resilience', () => {
  const source = (responses: StubOptions[], poll = {}): RemoteBundleSource => (
    new RemoteBundleSource({
    ...BASE,
    key: BASE.verify,
    poll,
    fetchImpl: stubFetch(responses).impl,
    })
  );

  it('degrades after repeated failures but keeps the last good bundle', async () => {
    const subject = source([{ fail: true }], { degradeAfterFailures: 2 });

    await expect(subject.load()).rejects.toThrow();
    expect(subject.snapshot().degraded).toBe(false);

    await expect(subject.load()).rejects.toThrow();
    const state = subject.snapshot();
    expect(state.degraded).toBe(true);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.lastError).toContain('network unreachable');
  });

  it('recovers from degraded once a fetch succeeds', async () => {
    const responses: StubOptions[] = [
      { fail: true },
      { fail: true },
      { body: signEcdsa(bundle()) },
    ];
    const subject = new RemoteBundleSource({
      ...BASE,
      key: BASE.verify,
      poll: { degradeAfterFailures: 2 },
      fetchImpl: stubFetch(responses).impl,
    });

    await expect(subject.load()).rejects.toThrow();
    await expect(subject.load()).rejects.toThrow();
    expect(subject.snapshot().degraded).toBe(true);

    await subject.load();
    expect(subject.snapshot()).toMatchObject({
      degraded: false,
      consecutiveFailures: 0,
      lastError: undefined,
    });
  });

  it('backs off exponentially after failures and returns to the interval on success', async () => {
    const subject = source([{ fail: true }], {
      intervalMs: 5000,
      backoffBaseMs: 100,
      backoffMaxMs: 1000,
      backoffJitter: 0,
    });

    expect(subject.nextDelayMs()).toBe(5000);

    await expect(subject.load()).rejects.toThrow();
    expect(subject.nextDelayMs()).toBe(100);

    await expect(subject.load()).rejects.toThrow();
    expect(subject.nextDelayMs()).toBe(200);

    await expect(subject.load()).rejects.toThrow();
    expect(subject.nextDelayMs()).toBe(400);
  });

  it('caps the backoff', async () => {
    const subject = source([{ fail: true }], {
      backoffBaseMs: 100, backoffMaxMs: 250, backoffJitter: 0,
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      // Sequential by nature: each failure advances the backoff state.
       
      await expect(subject.load()).rejects.toThrow();
    }
    expect(subject.nextDelayMs()).toBe(250);
  });

  it('keeps jittered delays within the configured spread', async () => {
    const subject = source([{ fail: true }], {
      backoffBaseMs: 1000, backoffMaxMs: 10_000, backoffJitter: 0.2,
    });
    await expect(subject.load()).rejects.toThrow();

    for (let sample = 0; sample < 50; sample += 1) {
      const delay = subject.nextDelayMs();
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1200);
    }
  });

  it('never puts the runtime key in the description', () => {
    expect(JSON.stringify(source([{ body: {} }]).describe())).not.toContain('rk_test');
  });

  it('is safe to stop when never started', () => {
    expect(() => source([{ body: {} }]).stop()).not.toThrow();
  });
});
