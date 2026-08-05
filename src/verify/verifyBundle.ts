import { createHmac, createVerify, timingSafeEqual } from 'node:crypto';
import { canonicalPayload, verifyChecksum } from '../bundle/canonical.js';
import { validateBundle } from '../bundle/validate.js';
import {
  isRecord, isNonEmptyString,
  type BundleOrigin, type BundleSignature, type RuntimeBundle,
} from '../bundle/types.js';
import { BundleSignatureError, BundleValidationError } from '../errors/errors.js';
import { parseHmacSecret, parsePublicKey } from './keys.js';

/**
 * The single verification path.
 *
 * Version 1.x had two, and they disagreed with each other and with both
 * producers: one canonicalised the whole response body, the other the whole
 * document minus `signature`, while `gp-worker` and the CLI both sign a field
 * projection. Local and remote bundles now differ only in *where the bytes came
 * from* — never in how they are canonicalised, validated or verified.
 *
 * The order is deliberate:
 *
 *     structure → checksum → signature
 *
 * A document that is not a well-formed bundle cannot be meaningfully verified,
 * and reporting "invalid signature" for a truncated file sends the reader
 * looking in entirely the wrong place.
 */

/** How to verify a bundle's signature. */
export type VerificationKey =
  | { algorithm: 'ECDSA_SHA_256'; publicKey: string }
  | { algorithm: 'HMAC_SHA256'; secret: string };

export interface VerifyOptions {
  /**
   * Where the bundle came from. Governs which algorithms are acceptable —
   * see the note on HMAC below.
   */
  origin: BundleOrigin;
  /** Omit to skip signature verification; requires `allowUnsigned`. */
  key?: VerificationKey | undefined;
  /**
   * Accept a bundle with no signature.
   *
   * Off by default. A bundle is a governance artifact: evaluating one whose
   * provenance you cannot establish should be a decision somebody wrote down,
   * not the default behaviour.
   */
  allowUnsigned?: boolean;
  /** Whether `orgId` and `projectId` are required. Defaults by origin. */
  scope?: 'required' | 'optional';
}

export interface VerifiedBundle {
  bundle: RuntimeBundle;
  signature: {
    status: 'verified' | 'unsigned';
    algorithm?: string;
    keyId?: string;
  };
  checksum: { status: 'verified' | 'absent' };
}

/**
 * HMAC is symmetric, so verifying one means holding the key that signs it.
 * That is fine for a bundle a developer signed with the CLI on their own
 * machine — they own both halves. It is not acceptable from Govplane Cloud,
 * where signing happens in a FIPS 140-3 Level 3 HSM and a key that can leave
 * the module defeats the entire claim.
 *
 * See `specs/compliance/fips-140-3.md` §5.
 */
const ALGORITHMS_BY_ORIGIN: Record<BundleOrigin, string[]> = {
  local: ['ECDSA_SHA_256', 'HMAC_SHA256'],
  remote: ['ECDSA_SHA_256'],
};

/** Ed25519 was accepted by the 1.x isolated-mode verifier. Nothing ever produced it. */
const REMOVED_ALGORITHMS = new Set(['Ed25519', 'ED25519', 'ed25519']);

export const readSignature = (document: unknown): BundleSignature | null => {
  if (!isRecord(document) || !isRecord(document.signature)) {
    return null;
  }

  const { signature } = document;
  if (!isNonEmptyString(signature.algorithm) || !isNonEmptyString(signature.value)) {
    return null;
  }

  return {
    algorithm: signature.algorithm,
    keyId: isNonEmptyString(signature.keyId) ? signature.keyId : '',
    value: signature.value,
  };
};

const verifyHmac = (payload: Buffer, signature: BundleSignature, secret: string): boolean => {
  const expected = createHmac('sha256', parseHmacSecret(secret)).update(payload).digest('hex');

  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(signature.value.toLowerCase(), 'utf8');

  // Length is checked first because timingSafeEqual throws on a mismatch; the
  // comparison itself stays constant-time.
  return left.length === right.length && timingSafeEqual(left, right);
};

const verifyEcdsa = (payload: Buffer, signature: BundleSignature, publicKey: string): boolean => {
  const key = parsePublicKey(publicKey);

  let raw: Buffer;
  try {
    raw = Buffer.from(signature.value, 'base64');
  } catch {
    return false;
  }
  if (raw.length === 0) {
    return false;
  }

  const verifier = createVerify('SHA256');
  verifier.update(payload);

  try {
    return verifier.verify(key, raw);
  } catch {
    // A malformed DER signature throws rather than returning false.
    return false;
  }
};

/**
 * Validates and verifies a bundle, returning it only if every configured check
 * passed. Throws otherwise — there is no partially trusted bundle.
 */
export const verifyBundle = (document: unknown, options: VerifyOptions): VerifiedBundle => {
  const scope = options.scope ?? (options.origin === 'remote' ? 'required' : 'optional');

  const issues = validateBundle(document, { scope });
  if (issues.length > 0) {
    throw new BundleValidationError(
      `The bundle failed validation with ${issues.length} error${issues.length === 1 ? '' : 's'}.`,
      issues[0]?.code ?? 'BUNDLE_INVALID',
      { issues },
    );
  }

  const bundle = document as RuntimeBundle;
  const payload = canonicalPayload(bundle);

  let checksumStatus: VerifiedBundle['checksum']['status'] = 'absent';
  if (isNonEmptyString(bundle.checksum)) {
    const comparison = verifyChecksum(bundle, bundle.checksum);
    if (!comparison.matches) {
      throw new BundleValidationError(
        'The bundle checksum does not match its contents.',
        'CHECKSUM_MISMATCH',
        comparison,
      );
    }
    checksumStatus = 'verified';
  }

  const signature = readSignature(bundle);

  if (signature === null) {
    if (options.key !== undefined) {
      throw new BundleSignatureError(
        'A verification key is configured, but the bundle carries no signature.',
        'BUNDLE_SIGNATURE_MISSING',
      );
    }
    if (options.allowUnsigned !== true) {
      throw new BundleSignatureError(
        'The bundle is unsigned. Configure a verification key, or pass allowUnsigned '
        + 'to accept it deliberately.',
        'BUNDLE_UNSIGNED',
      );
    }
    return {
      bundle,
      signature: { status: 'unsigned' },
      checksum: { status: checksumStatus },
    };
  }

  if (REMOVED_ALGORITHMS.has(signature.algorithm)) {
    throw new BundleSignatureError(
      'Ed25519 bundle signatures are no longer supported. Re-sign the bundle with '
      + 'ECDSA_SHA_256 (or HMAC_SHA256 for a locally signed bundle).',
      'BUNDLE_SIGNATURE_ALGORITHM_REMOVED',
      { algorithm: signature.algorithm },
    );
  }

  const acceptable = ALGORITHMS_BY_ORIGIN[options.origin];
  if (!acceptable.includes(signature.algorithm)) {
    throw new BundleSignatureError(
      options.origin === 'remote' && signature.algorithm === 'HMAC_SHA256'
        ? 'A bundle from Govplane Cloud must be signed with ECDSA_SHA_256. HMAC requires '
          + 'sharing the signing secret, which is not acceptable for a cloud-signed bundle.'
        : `Unsupported signature algorithm: ${signature.algorithm}`,
      'BUNDLE_SIGNATURE_ALGORITHM_UNSUPPORTED',
      { algorithm: signature.algorithm, acceptable },
    );
  }

  if (options.key === undefined) {
    if (options.allowUnsigned !== true) {
      throw new BundleSignatureError(
        'The bundle is signed but no verification key is configured, so the signature '
        + 'proves nothing. Configure a key, or pass allowUnsigned to evaluate it anyway.',
        'BUNDLE_SIGNATURE_UNVERIFIED',
        { algorithm: signature.algorithm, keyId: signature.keyId },
      );
    }
    return {
      bundle,
      signature: { status: 'unsigned', algorithm: signature.algorithm, keyId: signature.keyId },
      checksum: { status: checksumStatus },
    };
  }

  if (options.key.algorithm !== signature.algorithm) {
    throw new BundleSignatureError(
      `Signature algorithm mismatch: the configured key is ${options.key.algorithm}, `
      + `but the bundle was signed with ${signature.algorithm}.`,
      'BUNDLE_SIGNATURE_ALGORITHM_MISMATCH',
      { configured: options.key.algorithm, bundle: signature.algorithm },
    );
  }

  const valid = options.key.algorithm === 'HMAC_SHA256'
    ? verifyHmac(payload, signature, options.key.secret)
    : verifyEcdsa(payload, signature, options.key.publicKey);

  if (!valid) {
    throw new BundleSignatureError(
      'The bundle signature is not valid — it may have been modified after signing.',
      'BUNDLE_SIGNATURE_INVALID',
      { algorithm: signature.algorithm, keyId: signature.keyId },
    );
  }

  return {
    bundle,
    signature: { status: 'verified', algorithm: signature.algorithm, keyId: signature.keyId },
    checksum: { status: checksumStatus },
  };
};
