import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import { canonicalPayload, computeChecksum } from '../../src/bundle/canonical.js';
import { createLocalClient } from '../../src/client/createLocalClient.js';
import { LocalBundleSource } from '../../src/source/LocalBundleSource.js';
import type { RuntimeBundle } from '../../src/bundle/types.js';

const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PUBLIC_KEY = ecdsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HMAC_SECRET = 'd'.repeat(64);

const baseBundle = (denyAt = 5): RuntimeBundle => ({
  schemaVersion: 1,
  env: 'prod',
  generatedAt: '2026-08-02T00:00:00.000Z',
  bundleVersion: 1,
  policies: [{
    policyKey: 'login-protection',
    activeVersion: 1,
    defaults: { effect: 'allow' },
    rules: [{
      id: 'deny-after-five',
      status: 'active',
      priority: 100,
      target: { service: 'auth', resource: 'login', action: 'authenticate' },
      when: { op: 'gte', path: 'ctx.failedAttempts', value: denyAt },
      effect: { type: 'deny' },
    }],
  }],
});

const withChecksum = (bundle: RuntimeBundle): RuntimeBundle => ({
  ...bundle,
  checksum: computeChecksum(bundle),
});

const signEcdsa = (bundle: RuntimeBundle): RuntimeBundle => {
  const signer = createSign('SHA256');
  signer.update(canonicalPayload(bundle));
  return {
    ...bundle,
    signature: {
      algorithm: 'ECDSA_SHA_256',
      keyId: 'release',
      value: signer.sign(ecdsa.privateKey).toString('base64'),
    },
  };
};

const signHmac = (bundle: RuntimeBundle): RuntimeBundle => ({
  ...bundle,
  signature: {
    algorithm: 'HMAC_SHA256',
    keyId: 'local-key-01',
    value: createHmac('sha256', Buffer.from(HMAC_SECRET, 'hex'))
      .update(canonicalPayload(bundle))
      .digest('hex'),
  },
});

const TARGET = { service: 'auth', resource: 'login', action: 'authenticate' };

describe('createLocalClient', () => {
  let root: string;
  let bundlePath: string;

  const write = (bundle: RuntimeBundle): void => {
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'govplane-sdk-local-'));
    mkdirSync(root, { recursive: true });
    bundlePath = join(root, 'policy-bundle.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('evaluates a signed bundle with no credentials of any kind', async () => {
    write(signEcdsa(withChecksum(baseBundle())));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
    });

    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 6 } }))
      .toMatchObject({ decision: 'deny', reason: 'rule', ruleId: 'deny-after-five' });
    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 1 } }))
      .toMatchObject({ decision: 'allow', reason: 'default' });

    client.close();
  });

  it('verifies an HMAC-signed bundle, as the CLI produces', async () => {
    write(signHmac(baseBundle()));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'HMAC_SHA256', secret: HMAC_SECRET },
    });

    expect(client.status().signature).toMatchObject({
      status: 'verified',
      algorithm: 'HMAC_SHA256',
    });
    client.close();
  });

  it('needs no orgId or projectId', async () => {
    write(signEcdsa(baseBundle()));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
    });

    expect(client.bundle().orgId).toBeUndefined();
    expect(client.status().policies).toBe(1);
    client.close();
  });

  it('refuses to start without a key unless told to', async () => {
    write(baseBundle());

    await expect(createLocalClient({ bundlePath }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  });

  it('loads an unsigned bundle on explicit opt-in', async () => {
    write(baseBundle());

    const client = await createLocalClient({ bundlePath, allowUnsigned: true });
    expect(client.status().signature.status).toBe('unsigned');
    client.close();
  });

  it('refuses a tampered bundle', async () => {
    const signed = signEcdsa(baseBundle());
    (signed.policies[0] as { activeVersion: number }).activeVersion = 99;
    write(signed);

    await expect(createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
    })).rejects.toMatchObject({ code: 'BUNDLE_SIGNATURE_INVALID' });
  });

  it('reports a missing file as a read error', async () => {
    await expect(createLocalClient({
      bundlePath: join(root, 'absent.json'),
      allowUnsigned: true,
    })).rejects.toMatchObject({ code: 'BUNDLE_READ_ERROR' });
  });

  it('reports malformed JSON distinctly from a malformed bundle', async () => {
    writeFileSync(bundlePath, '{ not json');
    await expect(createLocalClient({ bundlePath, allowUnsigned: true }))
      .rejects.toMatchObject({ code: 'BUNDLE_PARSE_ERROR' });

    writeFileSync(bundlePath, JSON.stringify({ schemaVersion: 1, env: 'prod' }));
    await expect(createLocalClient({ bundlePath, allowUnsigned: true }))
      .rejects.toMatchObject({ code: 'POLICIES_NOT_ARRAY' });
  });

  it('reloads on request and adopts the new policies', async () => {
    write(signEcdsa(baseBundle(5)));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
    });

    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 3 } }).decision)
      .toBe('allow');

    write(signEcdsa(baseBundle(2)));
    await client.reload();

    expect(client.evaluate({ target: TARGET, context: { failedAttempts: 3 } }).decision)
      .toBe('deny');
    client.close();
  });

  it('reports what is loaded', async () => {
    write(signEcdsa(withChecksum(baseBundle())));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
    });

    expect(client.status()).toMatchObject({
      origin: 'local',
      location: bundlePath,
      bundleVersion: 1,
      env: 'prod',
      policies: 1,
      signature: { status: 'verified', algorithm: 'ECDSA_SHA_256', keyId: 'release' },
    });
    client.close();
  });

  it('does not enforce the sample context policy when none is configured', async () => {
    // The engine's DEFAULT_CONTEXT_POLICY is a seven-key sample. Enforcing it
    // by default rejects the keys a real bundle's own rules read, so a client
    // enforces a policy only when the application pinned one.
    write(signEcdsa(baseBundle()));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
    });

    expect(() => client.evaluate({ target: TARGET, context: { failedAttempts: 6 } }))
      .not.toThrow();
    client.close();
  });

  it('enforces a context policy the application did pin', async () => {
    write(signEcdsa(baseBundle()));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
      engine: { contextPolicy: { allowedKeys: ['failedAttempts'], blockLikelyPiiKeys: false } },
    });

    expect(() => client.evaluate({ target: TARGET, context: { failedAttempts: 6 } }))
      .not.toThrow();
    expect(() => client.evaluate({ target: TARGET, context: { email: 'a@b.c' } }))
      .toThrow();
    client.close();
  });

  it('honours validateContext: false even with a policy pinned', async () => {
    write(signEcdsa(baseBundle()));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
      engine: { validateContext: false, contextPolicy: { allowedKeys: ['nothing'] } },
    });

    expect(() => client.evaluate({ target: TARGET, context: { anything: 1 } })).not.toThrow();
    client.close();
  });

  it('passes engine options through', async () => {
    write(signEcdsa(baseBundle()));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
      engine: { validateContext: true, contextPolicy: { allowedKeys: ['failedAttempts'] } },
    });

    expect(() => client.evaluate({ target: TARGET, context: { notAllowed: 1 } })).toThrow();
    client.close();
  });

  it('produces a trace through the same engine', async () => {
    write(signEcdsa(baseBundle()));

    const client = await createLocalClient({
      bundlePath,
      verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
    });

    const result = client.evaluateWithTrace(
      { target: TARGET, context: { failedAttempts: 6 } },
      { level: 'full', force: true },
    );

    expect(result.trace).toBeDefined();
    client.close();
  });
});

describe('LocalBundleSource watching', () => {
  let root: string;
  let bundlePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'govplane-sdk-watch-'));
    bundlePath = join(root, 'policy-bundle.json');
    writeFileSync(bundlePath, JSON.stringify(signEcdsa(baseBundle(5))));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const source = (): LocalBundleSource => new LocalBundleSource({
    bundlePath,
    key: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
    watch: { intervalMs: 10 },
  });

  it('reports a change after the file is rewritten', async () => {
    const changes: unknown[] = [];
    const errors: unknown[] = [];
    const handlers = {
      onChange: (loaded: unknown) => changes.push(loaded),
      onError: (error: unknown) => errors.push(error),
    };
    const subject = source();

    // The first poll establishes a baseline and must not report a change.
    await subject.pollOnce(handlers);
    expect(changes).toHaveLength(0);

    writeFileSync(bundlePath, JSON.stringify(signEcdsa(baseBundle(2))));
    await subject.pollOnce(handlers);

    expect(changes).toHaveLength(1);
    expect(errors).toEqual([]);
    subject.stop();
  });

  it('reports an error and keeps the previous bundle when a reload fails', async () => {
    const changes: unknown[] = [];
    const errors: unknown[] = [];
    const handlers = {
      onChange: (loaded: unknown) => changes.push(loaded),
      onError: (error: unknown) => errors.push(error),
    };
    const subject = source();

    await subject.pollOnce(handlers);
    writeFileSync(bundlePath, '{ broken');
    await subject.pollOnce(handlers);

    expect(changes).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { code: string }).code).toBe('BUNDLE_PARSE_ERROR');
    subject.stop();
  });

  it('does not report a change when nothing changed', async () => {
    const changes: unknown[] = [];
    const handlers = { onChange: () => changes.push(1), onError: () => {} };
    const subject = source();

    await subject.pollOnce(handlers);
    await subject.pollOnce(handlers);
    await subject.pollOnce(handlers);

    expect(changes).toHaveLength(0);
    subject.stop();
  });

  it('reports a change made between the initial load and the first poll', async () => {
    // The window a deployment lands in: the service starts, reads the bundle,
    // and a new one is written before the first poll comes round. Baselining on
    // that poll instead of on the load would adopt the new file as the starting
    // point and never read it — losing the change for the life of the process
    // rather than merely delaying it.
    const changes: unknown[] = [];
    const errors: unknown[] = [];
    const handlers = {
      onChange: (loaded: unknown) => changes.push(loaded),
      onError: (error: unknown) => errors.push(error),
    };
    const subject = source();

    await subject.load();
    writeFileSync(bundlePath, JSON.stringify(signEcdsa(baseBundle(2))));

    await subject.pollOnce(handlers);

    expect(changes).toHaveLength(1);
    expect(errors).toEqual([]);
    subject.stop();
  });

  it('reports a bad file once rather than on every poll', async () => {
    const errors: unknown[] = [];
    const handlers = { onChange: () => {}, onError: (error: unknown) => errors.push(error) };
    const subject = source();

    await subject.load();
    writeFileSync(bundlePath, '{ broken');

    await subject.pollOnce(handlers);
    await subject.pollOnce(handlers);
    await subject.pollOnce(handlers);

    expect(errors).toHaveLength(1);
    subject.stop();
  });

  it('is safe to stop when never started', () => {
    expect(() => new LocalBundleSource({ bundlePath }).stop()).not.toThrow();
  });
});
