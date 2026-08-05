import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { canonicalPayload, computeChecksum } from '../../src/bundle/canonical.js';
import { verifyBundle, type VerificationKey } from '../../src/verify/verifyBundle.js';
import type { RuntimeBundle } from '../../src/bundle/types.js';
import { bundleFor, vectorFile } from '../helpers/vectors.js';

const { keys, vectors } = vectorFile();

const bundle = (): RuntimeBundle => ({
  schemaVersion: 1,
  orgId: 'org_1',
  projectId: 'proj_1',
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
      when: { op: 'gte', path: 'ctx.failedAttempts', value: 5 },
      effect: { type: 'deny' },
    }],
  }],
});

const HMAC_SECRET = 'b'.repeat(64);
const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ECDSA_PUBLIC = ecdsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const signHmac = (target: RuntimeBundle, secret = HMAC_SECRET): RuntimeBundle => ({
  ...target,
  signature: {
    algorithm: 'HMAC_SHA256',
    keyId: 'local-key-01',
    value: createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(canonicalPayload(target))
      .digest('hex'),
  },
});

const signEcdsa = (target: RuntimeBundle, key = ecdsa.privateKey): RuntimeBundle => {
  const signer = createSign('SHA256');
  signer.update(canonicalPayload(target));
  return {
    ...target,
    signature: {
      algorithm: 'ECDSA_SHA_256',
      keyId: 'release-key',
      value: signer.sign(key).toString('base64'),
    },
  };
};

const HMAC_KEY: VerificationKey = { algorithm: 'HMAC_SHA256', secret: HMAC_SECRET };
const ECDSA_KEY: VerificationKey = { algorithm: 'ECDSA_SHA_256', publicKey: ECDSA_PUBLIC };

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE';
  }
  return 'DID_NOT_THROW';
};

describe('verifying the shared fixtures', () => {
  // The vectors were produced by the CLI's implementation. Verifying them here
  // is the cross-implementation check: SDK verification accepts exactly what
  // the CLI signs.
  it.each(Object.keys(vectors))('verifies the ECDSA signature over %s', (name) => {
    const vector = vectors[name] as NonNullable<(typeof vectors)[string]>;
    const signed = {
      ...(bundleFor(name) as RuntimeBundle),
      signature: {
        algorithm: 'ECDSA_SHA_256',
        keyId: vector.signatures.ECDSA_SHA_256.keyId,
        value: vector.signatures.ECDSA_SHA_256.value,
      },
    };

    const result = verifyBundle(signed, {
      origin: 'local',
      key: { algorithm: 'ECDSA_SHA_256', publicKey: keys.ecdsaPublicKeyPem },
    });

    expect(result.signature.status).toBe('verified');
  });

  it.each(Object.keys(vectors))('verifies the HMAC signature over %s', (name) => {
    const vector = vectors[name] as NonNullable<(typeof vectors)[string]>;
    const signed = {
      ...(bundleFor(name) as RuntimeBundle),
      signature: {
        algorithm: 'HMAC_SHA256',
        keyId: vector.signatures.HMAC_SHA256.keyId,
        value: vector.signatures.HMAC_SHA256.value,
      },
    };

    const result = verifyBundle(signed, {
      origin: 'local',
      key: { algorithm: 'HMAC_SHA256', secret: keys.hmacSecretHex },
    });

    expect(result.signature.status).toBe('verified');
  });
});

describe('verifyBundle', () => {
  it('accepts a correctly HMAC-signed local bundle', () => {
    const result = verifyBundle(signHmac(bundle()), { origin: 'local', key: HMAC_KEY });
    expect(result.signature).toMatchObject({ status: 'verified', algorithm: 'HMAC_SHA256' });
  });

  it('accepts a correctly ECDSA-signed bundle from either origin', () => {
    const signed = signEcdsa(bundle());
    expect(verifyBundle(signed, { origin: 'local', key: ECDSA_KEY }).signature.status)
      .toBe('verified');
    expect(verifyBundle(signed, { origin: 'remote', key: ECDSA_KEY }).signature.status)
      .toBe('verified');
  });

  it('verifies an embedded checksum when present', () => {
    const withChecksum = { ...bundle(), checksum: computeChecksum(bundle()) };
    const result = verifyBundle(signEcdsa(withChecksum), { origin: 'local', key: ECDSA_KEY });
    expect(result.checksum.status).toBe('verified');
  });

  it('reports an absent checksum rather than inventing one', () => {
    expect(verifyBundle(signEcdsa(bundle()), { origin: 'local', key: ECDSA_KEY }).checksum.status)
      .toBe('absent');
  });
});

describe('the tamper matrix', () => {
  it('rejects a bundle whose policies changed after signing', () => {
    const signed = signEcdsa(bundle());
    (signed.policies[0] as { activeVersion: number }).activeVersion = 99;

    expect(codeOf(() => verifyBundle(signed, { origin: 'local', key: ECDSA_KEY })))
      .toBe('BUNDLE_SIGNATURE_INVALID');
  });

  it('rejects a bundle whose checksum no longer matches', () => {
    const tampered = { ...bundle(), checksum: 'sha256:0000' };
    expect(codeOf(() => verifyBundle(signEcdsa(tampered), { origin: 'local', key: ECDSA_KEY })))
      .toBe('CHECKSUM_MISMATCH');
  });

  it('rejects a signature made with a different key', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(codeOf(() => verifyBundle(
      signEcdsa(bundle(), other.privateKey),
      { origin: 'local', key: ECDSA_KEY },
    ))).toBe('BUNDLE_SIGNATURE_INVALID');
  });

  it('rejects an HMAC made with a different secret', () => {
    expect(codeOf(() => verifyBundle(
      signHmac(bundle(), 'c'.repeat(64)),
      { origin: 'local', key: HMAC_KEY },
    ))).toBe('BUNDLE_SIGNATURE_INVALID');
  });

  it('rejects a key whose algorithm differs from the signature', () => {
    expect(codeOf(() => verifyBundle(signHmac(bundle()), { origin: 'local', key: ECDSA_KEY })))
      .toBe('BUNDLE_SIGNATURE_ALGORITHM_MISMATCH');
  });

  it('rejects an HMAC-signed bundle from Govplane Cloud', () => {
    // The FIPS decision: a cloud signature must come from a key that never
    // leaves the HSM, which rules out a shared secret.
    expect(codeOf(() => verifyBundle(signHmac(bundle()), { origin: 'remote', key: HMAC_KEY })))
      .toBe('BUNDLE_SIGNATURE_ALGORITHM_UNSUPPORTED');
  });

  it('rejects an Ed25519 signature with a message naming the replacement', () => {
    const signed = {
      ...bundle(),
      signature: { algorithm: 'Ed25519', keyId: 'old', value: 'AAAA' },
    };

    try {
      verifyBundle(signed, { origin: 'local', key: ECDSA_KEY });
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as { code: string }).code).toBe('BUNDLE_SIGNATURE_ALGORITHM_REMOVED');
      expect((error as Error).message).toContain('ECDSA_SHA_256');
    }
  });

  it('rejects an unknown algorithm', () => {
    const signed = { ...bundle(), signature: { algorithm: 'RSA_PSS', keyId: 'k', value: 'x' } };
    expect(codeOf(() => verifyBundle(signed, { origin: 'local', key: ECDSA_KEY })))
      .toBe('BUNDLE_SIGNATURE_ALGORITHM_UNSUPPORTED');
  });

  it('rejects a signature that is not valid base64 DER', () => {
    const signed = {
      ...bundle(),
      signature: { algorithm: 'ECDSA_SHA_256', keyId: 'k', value: 'not-a-signature' },
    };
    expect(codeOf(() => verifyBundle(signed, { origin: 'local', key: ECDSA_KEY })))
      .toBe('BUNDLE_SIGNATURE_INVALID');
  });

  it('rejects malformed key material as configuration, not as tampering', () => {
    expect(codeOf(() => verifyBundle(signEcdsa(bundle()), {
      origin: 'local',
      key: { algorithm: 'ECDSA_SHA_256', publicKey: 'not a key' },
    }))).toBe('BUNDLE_SIGNATURE_CONFIG_ERROR');

    expect(codeOf(() => verifyBundle(signHmac(bundle()), {
      origin: 'local',
      key: { algorithm: 'HMAC_SHA256', secret: 'too-short' },
    }))).toBe('BUNDLE_SIGNATURE_CONFIG_ERROR');
  });
});

describe('unsigned bundles', () => {
  it('refuses an unsigned bundle by default', () => {
    expect(codeOf(() => verifyBundle(bundle(), { origin: 'local' }))).toBe('BUNDLE_UNSIGNED');
  });

  it('accepts an unsigned bundle only on explicit opt-in', () => {
    const result = verifyBundle(bundle(), { origin: 'local', allowUnsigned: true });
    expect(result.signature.status).toBe('unsigned');
  });

  it('refuses a signed bundle with no key rather than pretending it is verified', () => {
    // The signature is present but proves nothing without a key. Reporting it
    // as verified would be the most dangerous possible lie.
    expect(codeOf(() => verifyBundle(signEcdsa(bundle()), { origin: 'local' })))
      .toBe('BUNDLE_SIGNATURE_UNVERIFIED');
  });

  it('reports a signed-but-unverified bundle honestly when allowed', () => {
    const result = verifyBundle(signEcdsa(bundle()), { origin: 'local', allowUnsigned: true });
    expect(result.signature).toMatchObject({
      status: 'unsigned',
      algorithm: 'ECDSA_SHA_256',
    });
  });

  it('refuses a key with no signature to verify', () => {
    expect(codeOf(() => verifyBundle(bundle(), { origin: 'local', key: ECDSA_KEY })))
      .toBe('BUNDLE_SIGNATURE_MISSING');
  });
});

describe('structural validation runs first', () => {
  it('reports a malformed bundle as invalid, not as a bad signature', () => {
    const broken = { ...signEcdsa(bundle()), policies: 'nonsense' };
    expect(codeOf(() => verifyBundle(broken, { origin: 'local', key: ECDSA_KEY })))
      .toBe('POLICIES_NOT_ARRAY');
  });

  it('requires scope on a remote bundle and not on a local one', () => {
    const scopeless = { ...bundle(), orgId: undefined, projectId: undefined };

    expect(codeOf(() => verifyBundle(signEcdsa(scopeless), {
      origin: 'remote', key: ECDSA_KEY,
    }))).toBe('MISSING_SCOPE_FIELDS');

    expect(verifyBundle(signEcdsa(scopeless), { origin: 'local', key: ECDSA_KEY })
      .signature.status).toBe('verified');
  });

  it('rejects a bundleVersion that is not a positive whole number', () => {
    const bad = { ...bundle(), bundleVersion: 0 };
    expect(codeOf(() => verifyBundle(bad, { origin: 'local', allowUnsigned: true })))
      .toBe('INVALID_BUNDLE_VERSION');
  });

  it('accepts a bundleVersion greater than 1', () => {
    const republished = { ...bundle(), bundleVersion: 42 };
    expect(verifyBundle(republished, { origin: 'local', allowUnsigned: true }).bundle.bundleVersion)
      .toBe(42);
  });
});
