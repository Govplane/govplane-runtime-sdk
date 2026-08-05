import { describe, expect, it } from '@jest/globals';
import {
  canonicalPayload, computeChecksum, etagFromChecksum, projectCanonicalBundle,
  sortKeysDeep, verifyChecksum,
} from '../../src/bundle/canonical.js';
import { bundleFor, vectorFile, vectorNames } from '../helpers/vectors.js';

describe('canonicalisation matches the shared fixtures', () => {
  const { vectors } = vectorFile();

  it.each(vectorNames())('%s produces the expected bytes', (name) => {
    const expected = vectors[name] as NonNullable<(typeof vectors)[string]>;
    const actual = canonicalPayload(bundleFor(name));

    // Byte-for-byte, not merely equivalent JSON. A checksum can match across
    // two different serialisations by coincidence; the bytes cannot.
    expect(actual.toString('utf8')).toBe(expected.canonicalUtf8);
    expect(actual.length).toBe(expected.byteLength);
  });

  it.each(vectorNames())('%s produces the expected checksum', (name) => {
    const expected = vectors[name] as NonNullable<(typeof vectors)[string]>;
    expect(computeChecksum(bundleFor(name))).toBe(expected.checksum);
  });
});

describe('projectCanonicalBundle', () => {
  it('keeps only the signed fields', () => {
    const projected = projectCanonicalBundle({
      schemaVersion: 1,
      orgId: 'o',
      projectId: 'p',
      env: 'prod',
      generatedAt: '2026-08-02T00:00:00.000Z',
      bundleVersion: 9,
      checksum: 'sha256:whatever',
      etag: '"whatever"',
      signature: { algorithm: 'HMAC_SHA256', keyId: 'k', value: 'v' },
      policies: [],
    });

    expect(Object.keys(projected).sort())
      .toEqual(['env', 'orgId', 'policies', 'projectId', 'schemaVersion']);
  });

  it('keeps only the signed fields of a policy', () => {
    const projected = projectCanonicalBundle({
      policies: [{
        policyKey: 'p',
        activeVersion: 1,
        defaults: { effect: 'allow' },
        rules: [],
        friendlyName: 'ignored',
        description: 'ignored',
        discoveredTarget: { service: 'ignored' },
      }],
    });

    expect(Object.keys(projected.policies[0] as object).sort())
      .toEqual(['activeVersion', 'defaults', 'policyKey', 'rules']);
  });

  it('leaves an absent scope absent rather than null', () => {
    // The distinction is load-bearing: `govplane build` omits orgId entirely,
    // and an implementation that writes `"orgId":null` produces different bytes
    // and therefore a signature nobody else accepts.
    const bytes = canonicalPayload({ schemaVersion: 1, env: 'prod', policies: [] });
    expect(bytes.toString('utf8')).toBe('{"env":"prod","policies":[],"schemaVersion":1}');
  });

  it('pins the schema version rather than echoing the input', () => {
    expect(projectCanonicalBundle({ schemaVersion: 99 }).schemaVersion).toBe(1);
  });

  it('survives a document that is not a bundle at all', () => {
    expect(() => canonicalPayload(null)).not.toThrow();
    expect(() => canonicalPayload('nonsense')).not.toThrow();
    expect(projectCanonicalBundle(undefined).policies).toEqual([]);
  });

  it('survives a policies entry that is not an object', () => {
    expect(projectCanonicalBundle({ policies: [null, 7] }).policies).toHaveLength(2);
  });
});

describe('sortKeysDeep', () => {
  it('sorts nested objects, including inside arrays', () => {
    const sorted = sortKeysDeep({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } });
    expect(JSON.stringify(sorted)).toBe('{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}');
  });

  it('does not reorder array elements', () => {
    expect(sortKeysDeep(['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('leaves scalars and null alone', () => {
    expect(sortKeysDeep(null)).toBeNull();
    expect(sortKeysDeep(7)).toBe(7);
    expect(sortKeysDeep('x')).toBe('x');
  });

  it('is independent of the order keys were written in', () => {
    const one = { schemaVersion: 1, env: 'prod', policies: [] };
    const two = { policies: [], env: 'prod', schemaVersion: 1 };
    expect(canonicalPayload(one).toString('utf8'))
      .toBe(canonicalPayload(two).toString('utf8'));
  });
});

describe('checksums', () => {
  const bundle = { schemaVersion: 1, env: 'prod', policies: [] };

  it('is stable across repeated computation', () => {
    expect(computeChecksum(bundle)).toBe(computeChecksum(bundle));
  });

  it('ignores fields outside the projection', () => {
    // Re-versioning or re-materialising a bundle must not invalidate its
    // signature, which is the entire reason these fields are excluded.
    const republished = {
      ...bundle,
      bundleVersion: 42,
      generatedAt: '2027-01-01T00:00:00.000Z',
      signature: { algorithm: 'HMAC_SHA256', keyId: 'k', value: 'v' },
    };
    expect(computeChecksum(republished)).toBe(computeChecksum(bundle));
  });

  it('changes when a policy changes', () => {
    const altered = { ...bundle, policies: [{ policyKey: 'p', activeVersion: 1, rules: [] }] };
    expect(computeChecksum(altered)).not.toBe(computeChecksum(bundle));
  });

  it('compares case-insensitively, since hex casing is not meaningful', () => {
    const checksum = computeChecksum(bundle);
    expect(verifyChecksum(bundle, checksum.toUpperCase()).matches).toBe(true);
  });

  it('reports a mismatch with both values', () => {
    const result = verifyChecksum(bundle, 'sha256:0000');
    expect(result.matches).toBe(false);
    expect(result.expected).toBe('sha256:0000');
    expect(result.actual).toBe(computeChecksum(bundle));
  });

  it('derives an ETag by quoting the hex', () => {
    expect(etagFromChecksum('sha256:abc')).toBe('"abc"');
    expect(etagFromChecksum('abc')).toBe('"abc"');
  });
});
