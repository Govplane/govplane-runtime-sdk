import type { DecisionCounter } from '../../src/observe/types.js';
import {
  createTransport, toDataPoints, MAX_POINTS_PER_BATCH, QUOTA_COOLOFF_MS,
} from '../../src/observe/transport.js';

const counter = (over: Partial<DecisionCounter> = {}): DecisionCounter => ({
  policyKey: 'p1',
  ruleId: 'r1',
  decision: 'allow',
  reason: 'rule',
  bundleVersion: 7,
  count: 3,
  ...over,
});

interface Call { url: string; init: RequestInit }

const recorder = (respond: (call: number) => Partial<Response>) => {
  const calls: Call[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return { ok: false, status: 500, ...respond(calls.length) } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
};

const baseConfig = {
  endpoint: 'https://abc.ingest.govplane.com',
  runtimeKey: 'rt_key',
  projectId: 'proj_1',
  env: 'prod',
  source: 'checkout-api',
};

describe('data point shape', () => {
  it('matches what gp-data ingests', () => {
    const [point] = toDataPoints([counter()], Date.UTC(2026, 0, 1), { source: 'svc' });

    expect(point).toMatchObject({
      source: 'svc',
      category: 'policy_decision',
      value: 3,
      unit: 'count',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(point?.tags).toMatchObject({
      policyKey: 'p1', ruleId: 'r1', decision: 'allow', bundleVersion: '7',
    });
  });

  it('omits an absent bundle version rather than stringifying undefined', () => {
    // "undefined" as a tag value would look like a real version in a chart.
    const [point] = toDataPoints([counter({ bundleVersion: undefined })], 0, { source: 's' });
    expect(point?.tags).not.toHaveProperty('bundleVersion');
  });

  it('carries instanceId when configured, for fleet-aware conditions', () => {
    const [point] = toDataPoints([counter()], 0, { source: 's', instanceId: 'pod-7' });
    expect(point?.tags.instanceId).toBe('pod-7');
  });
});

describe('request', () => {
  it('posts to the ingest host with project and env in the path', async () => {
    const { calls, impl } = recorder(() => ({ ok: true, status: 202 }));
    await createTransport({ ...baseConfig, fetchImpl: impl }).send([counter()], 0);

    expect(calls[0]?.url).toBe(
      'https://abc.ingest.govplane.com/v1/proj_1/prod/metrics',
    );
  });

  it('sends the runtime key, unchanged from bundle polling', async () => {
    const { calls, impl } = recorder(() => ({ ok: true, status: 202 }));
    await createTransport({ ...baseConfig, fetchImpl: impl }).send([counter()], 0);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('rt_key');
  });

  it('carries an idempotency key so a retried timeout is not double-counted', async () => {
    const { calls, impl } = recorder(() => ({ ok: true, status: 202 }));
    await createTransport({ ...baseConfig, fetchImpl: impl }).send([counter()], 0);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeTruthy();
  });

  it('reuses one key across attempts of the same batch', async () => {
    // A fresh key per attempt would turn every retry into a second write.
    const { calls, impl } = recorder(
      (n) => (n < 3 ? { ok: false, status: 503 } : { ok: true, status: 202 }),
    );
    await createTransport({ ...baseConfig, fetchImpl: impl }).send([counter()], 0);

    const keys = new Set(
      calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key']),
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(keys.size).toBe(1);
  });

  it('splits oversized batches to gp-data ceiling', async () => {
    const { calls, impl } = recorder(() => ({ ok: true, status: 202 }));
    const many = Array.from(
      { length: MAX_POINTS_PER_BATCH + 10 },
      (_, i) => counter({ ruleId: `r${i}` }),
    );
    await createTransport({ ...baseConfig, fetchImpl: impl }).send(many, 0);

    expect(calls).toHaveLength(2);
  });
});

describe('failure handling', () => {
  it('retries a server fault', async () => {
    const { calls, impl } = recorder(
      (n) => (n === 1 ? { ok: false, status: 503 } : { ok: true, status: 202 }),
    );
    await createTransport({ ...baseConfig, fetchImpl: impl }).send([counter()], 0);
    expect(calls.length).toBe(2);
  });

  it('does not retry a rejected credential', async () => {
    // A 401 will be a 401 again; repeating it is a retry storm against a key
    // that has been revoked.
    const { calls, impl } = recorder(() => ({ ok: false, status: 401 }));
    await createTransport({ ...baseConfig, fetchImpl: impl }).send([counter()], 0);
    expect(calls).toHaveLength(1);
  });

  it('never throws at the caller when the network fails', async () => {
    const impl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const transport = createTransport({
      ...baseConfig, fetchImpl: impl, maxAttempts: 1, onError: (e) => errors.push(e),
    });

    await expect(transport.send([counter()], 0)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe('quota exhaustion', () => {
  it('stops sending after a 429 rather than retrying into a full quota', async () => {
    const { calls, impl } = recorder(() => ({ ok: false, status: 429 }));
    const transport = createTransport({ ...baseConfig, fetchImpl: impl });

    await transport.send([counter()], 0);
    expect(calls).toHaveLength(1);
    expect(transport.isPaused()).toBe(true);

    await transport.send([counter()], 0);
    expect(calls).toHaveLength(1);
  });

  it('reports the condition once, not on every rollup', async () => {
    const { impl } = recorder(() => ({ ok: false, status: 429 }));
    const errors: unknown[] = [];
    const transport = createTransport({
      ...baseConfig, fetchImpl: impl, onError: (e) => errors.push(e),
    });

    await transport.send([counter()], 0);
    await transport.send([counter()], 0);
    await transport.send([counter()], 0);

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/quota/i);
  });

  it('says plainly that evaluation is unaffected', async () => {
    // The message reaches an operator mid-incident. It has to answer "is my app
    // broken?" before anything else.
    const { impl } = recorder(() => ({ ok: false, status: 429 }));
    const errors: unknown[] = [];
    const transport = createTransport({
      ...baseConfig, fetchImpl: impl, onError: (e) => errors.push(e),
    });
    await transport.send([counter()], 0);

    expect(String(errors[0])).toMatch(/evaluation is unaffected/i);
  });

  it('resumes once the cool-off elapses', async () => {
    const { impl } = recorder(() => ({ ok: false, status: 429 }));
    const transport = createTransport({ ...baseConfig, fetchImpl: impl });
    await transport.send([counter()], 0);

    expect(transport.isPaused(Date.now() + QUOTA_COOLOFF_MS + 1)).toBe(false);
  });
});

describe('nothing is sent when there is nothing to send', () => {
  it('makes no request for an empty bucket', async () => {
    const { calls, impl } = recorder(() => ({ ok: true, status: 202 }));
    await createTransport({ ...baseConfig, fetchImpl: impl }).send([], 0);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The endpoint is normalised before it is ever used to build a URL, and how it
 * is normalised is a security property rather than a tidiness one.
 *
 * Flagged by CodeQL as a polynomial regular expression on uncontrolled data.
 * It was not theoretical: the shipped `replace(/\/+$/, '')` took **15.8
 * seconds** on 200 000 slashes, synchronously, on the thread constructing the
 * client.
 */
describe('normalising the endpoint', () => {
  const urlFor = (endpoint: string): string => {
    const { calls, impl } = recorder(() => ({ ok: true, status: 202 }));
    const transport = createTransport({ ...baseConfig, endpoint, fetchImpl: impl });
    void transport.sendPoints([{ name: 'n', value: 1 }] as never);
    return calls[0]?.url ?? '';
  };

  it('trims a trailing slash', () => {
    expect(urlFor('https://abc.ingest.govplane.com/'))
      .toBe('https://abc.ingest.govplane.com/v1/proj_1/prod/metrics');
  });

  it('trims a run of them', () => {
    expect(urlFor('https://abc.ingest.govplane.com////'))
      .toBe('https://abc.ingest.govplane.com/v1/proj_1/prod/metrics');
  });

  it('leaves an endpoint that needs no trimming alone', () => {
    expect(urlFor('https://abc.ingest.govplane.com'))
      .toBe('https://abc.ingest.govplane.com/v1/proj_1/prod/metrics');
  });

  it('trims only from the end', () => {
    // A path segment is legitimate: an ingest host behind a prefix still has to
    // work, and only the tail may be collapsed.
    expect(urlFor('https://abc.ingest.govplane.com/ingest//'))
      .toBe('https://abc.ingest.govplane.com/ingest/v1/proj_1/prod/metrics');
  });

  it('handles a run of slashes in linear time', () => {
    /**
     * The regression that matters. The bound is deliberately loose — it is
     * measuring the complexity class, not the machine it runs on. Quadratic
     * behaviour here missed it by four orders of magnitude.
     */
    const pathological = `${'/'.repeat(200_000)}x`;

    const started = process.hrtime.bigint();
    const url = urlFor(pathological);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Nothing is trimmed: the run does not reach the end of the string.
    expect(url.startsWith(pathological)).toBe(true);
    expect(elapsedMs).toBeLessThan(250);
  });
});
