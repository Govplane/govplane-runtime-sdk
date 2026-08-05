import type { RuntimeBundleV1 } from '../engine/types.js';

/**
 * Bundle-level types: what a bundle carries beyond the policies the engine
 * evaluates.
 */

export const SIGNATURE_ALGORITHMS = ['ECDSA_SHA_256', 'HMAC_SHA256'] as const;

export type SignatureAlgorithm = (typeof SIGNATURE_ALGORITHMS)[number];

export interface BundleSignature {
  algorithm: string;
  /** Which key signed it, so a verifier knows which one to reach for. */
  keyId: string;
  /** Lowercase hex for HMAC; base64 DER for ECDSA. */
  value: string;
}

/**
 * A runtime bundle as it exists on disk or on the wire.
 *
 * Everything beyond the engine's view is integrity and provenance metadata, and
 * all of it sits **outside** the signed bytes — see `canonical.ts`.
 */
export type RuntimeBundle = RuntimeBundleV1 & {
  /** Monotonic revision counter, per (orgId, projectId, env). Whole number ≥ 1. */
  bundleVersion?: number;
  /** `sha256:<hex>` over the canonical payload. */
  checksum?: string;
  etag?: string;
  signature?: BundleSignature;
};

/** Where a bundle came from. Determines which algorithms are acceptable. */
export type BundleOrigin = 'local' | 'remote';

export const ENVIRONMENTS = ['prod', 'staging', 'dev', 'test'] as const;

export const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim() !== ''
);
