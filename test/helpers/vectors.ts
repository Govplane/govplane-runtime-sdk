import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Signing fixtures: bundles with their expected canonical bytes, checksum and
 * signatures.
 *
 * They were generated from `@govplane/cli`'s implementation, so they record
 * what the CLI actually produces rather than a second opinion about what it
 * should. They live inside this package because it must be independently
 * testable — an SDK whose test suite reaches into another repository is not a
 * package, it is half of one.
 *
 * This makes them a *regression* check: they prove this SDK's canonicalisation
 * has not moved since the day it was verified against the CLI. Proving the two
 * implementations still agree with each other is a different question, and is
 * answered where both are already present — `@govplane/toolkit`, which depends
 * on the CLI and the SDK and carries `test/integration/signingParity.test.ts`.
 *
 * The normative copy is `specs/fixtures/signing/`. Regenerate from there when
 * the canonical form changes deliberately, which is a breaking change to every
 * signature ever issued.
 */

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(here, '..', 'fixtures', 'signing');

export interface SignatureVector {
  keyId: string;
  value: string;
}

export interface Vector {
  canonicalUtf8: string;
  canonicalSha256Hex: string;
  checksum: string;
  byteLength: number;
  signatures: {
    HMAC_SHA256: SignatureVector;
    ECDSA_SHA_256: SignatureVector;
  };
}

export interface VectorFile {
  keys: { hmacSecretHex: string; ecdsaPublicKeyPem: string };
  vectors: Record<string, Vector>;
}

export const vectorFile = (): VectorFile => JSON.parse(
  readFileSync(join(FIXTURES, 'vectors.json'), 'utf8'),
) as VectorFile;

export const bundleFor = (name: string): unknown => JSON.parse(
  readFileSync(join(FIXTURES, `${name}.bundle.json`), 'utf8'),
) as unknown;

export const vectorNames = (): string[] => Object.keys(vectorFile().vectors);
