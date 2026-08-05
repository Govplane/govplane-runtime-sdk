/**
 * Govplane Runtime SDK.
 *
 * Two ways in, one everything else:
 *
 *   createLocalClient  — a bundle from disk. No account, no key, no network.
 *   createRemoteClient — a bundle from Govplane Cloud.
 *
 * Both return the same client, backed by the same verification path and the
 * same policy engine. Nothing in this package requires Govplane
 * infrastructure.
 */

// ─── Clients ──────────────────────────────────────────────────────────────

export { createLocalClient, type LocalClientConfig } from './client/createLocalClient.js';
export { createRemoteClient, type RemoteClientConfig } from './client/createRemoteClient.js';
export type {
  ClientOptions, ClientStatus, EngineOptions, GovplaneClient, TraceOptionsConfig,
} from './client/GovplaneClient.js';

// ─── The engine ───────────────────────────────────────────────────────────
//
// Exported for callers that hold a bundle already and want evaluation with no
// source at all — `govplane simulate` is one.

export { createPolicyEngine } from './engine/createPolicyEngine.js';
export { formatTrace } from './engine/formatTrace.js';
export * from './engine/types.js';
export * from './engine/context.js';

// ─── Bundles, canonicalisation and verification ───────────────────────────

export {
  canonicalPayload, computeChecksum, etagFromChecksum, projectCanonicalBundle,
  sortKeysDeep, verifyChecksum,
  type CanonicalBundle, type ChecksumComparison,
} from './bundle/canonical.js';
export { validateBundle, type ValidationIssue, type ValidateOptions } from './bundle/validate.js';
export {
  SIGNATURE_ALGORITHMS,
  type BundleOrigin, type BundleSignature, type RuntimeBundle, type SignatureAlgorithm,
} from './bundle/types.js';
export {
  verifyBundle, readSignature,
  type VerificationKey, type VerifiedBundle, type VerifyOptions,
} from './verify/verifyBundle.js';

// ─── Sources, for callers building their own ──────────────────────────────

export { LocalBundleSource, type LocalSourceOptions } from './source/LocalBundleSource.js';
export {
  RemoteBundleSource, type RemoteSourceOptions, type RemoteState,
} from './source/RemoteBundleSource.js';
export type { BundleSource, LoadedBundle, SourceDescription } from './source/types.js';

// ─── Errors ───────────────────────────────────────────────────────────────

export {
  BundleSignatureError, BundleValidationError, ConfigurationError, GovplaneError, HttpError,
  SafeBundleValidationError,
} from './errors/errors.js';
