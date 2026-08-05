import { createHash } from 'node:crypto';

/**
 * Canonicalisation of runtime bundles.
 *
 * This module is **normative and duplicated on purpose**. The identical
 * projection and serialisation exist in three other places:
 *
 * - `gp-worker` — `BuildCanonicalBundle.usecase.ts` plus `sortDeep()` in its
 *   signing adapters. This is what Govplane Cloud actually signs.
 * - `@govplane/cli` — `src/domain/canonical.ts`. This is what `govplane build
 *   --signed` and `govplane sign` produce.
 * - This file — what the SDK verifies.
 *
 * They must agree byte for byte or signatures produced by one are rejected by
 * another, which is precisely the defect this SDK version exists to fix. The
 * duplication is deliberate rather than lazy: the SDK is a production runtime
 * library that must stay standalone and dependency-free, and it cannot take a
 * dependency on a CLI. What keeps the copies honest is the shared fixture set
 * in `specs/fixtures/signing/`, which every implementation asserts against —
 * including the Java, Python and PHP ports, which could never share a
 * JavaScript module anyway.
 *
 * **If you change anything here, change it in all four places and regenerate
 * the fixtures.** A silent divergence looks like "signature invalid" in
 * production, months later, on somebody else's machine.
 *
 * Projection — only these fields are covered:
 *
 *     schemaVersion, orgId, projectId, env,
 *     policies[] → policyKey, activeVersion, defaults, rules
 *
 * Deliberately excluded: `generatedAt`, `bundleVersion`, `checksum`, `etag`,
 * `signature`. Keeping the revision counter and the timestamp outside the
 * signed bytes is what lets a bundle be re-materialised or re-versioned without
 * invalidating its signature.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export interface CanonicalBundle {
  schemaVersion: 1;
  orgId: unknown;
  projectId: unknown;
  env: unknown;
  policies: {
    policyKey: unknown;
    activeVersion: unknown;
    defaults: unknown;
    rules: unknown;
  }[];
}

/**
 * Reduces a bundle to the fields the signature covers.
 *
 * Absent fields stay absent rather than becoming `null`: `JSON.stringify` drops
 * `undefined` object properties, so a bundle with no `orgId` serialises without
 * the key entirely. That is what the control plane produces for a locally built
 * bundle, and the two must match.
 */
export const projectCanonicalBundle = (bundle: unknown): CanonicalBundle => {
  const source = isRecord(bundle) ? bundle : {};
  const policies = Array.isArray(source.policies) ? source.policies : [];

  return {
    schemaVersion: 1,
    orgId: source.orgId,
    projectId: source.projectId,
    env: source.env,
    policies: policies.map((policy) => {
      const entry = isRecord(policy) ? policy : {};
      return {
        policyKey: entry.policyKey,
        activeVersion: entry.activeVersion,
        defaults: entry.defaults,
        rules: entry.rules,
      };
    }),
  };
};

/** Recursively sorts object keys so serialisation is independent of key order. */
export const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = sortKeysDeep(value[key]);
        return accumulator;
      }, {});
  }
  return value;
};

/** The exact bytes of a runtime bundle that are checksummed and signed. */
export const canonicalPayload = (bundle: unknown): Buffer => (
  Buffer.from(JSON.stringify(sortKeysDeep(projectCanonicalBundle(bundle))), 'utf8')
);

export const computeChecksum = (bundle: unknown): string => (
  `sha256:${createHash('sha256').update(canonicalPayload(bundle)).digest('hex')}`
);

export const etagFromChecksum = (checksum: string): string => {
  const hex = checksum.startsWith('sha256:') ? checksum.slice('sha256:'.length) : checksum;
  return `"${hex}"`;
};

export interface ChecksumComparison {
  expected: string;
  actual: string;
  matches: boolean;
}

export const verifyChecksum = (bundle: unknown, checksum: string): ChecksumComparison => {
  const actual = computeChecksum(bundle);
  return {
    expected: checksum,
    actual,
    matches: actual.toLowerCase() === checksum.toLowerCase(),
  };
};
