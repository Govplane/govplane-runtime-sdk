import { createPublicKey, type KeyObject } from 'node:crypto';
import { BundleSignatureError } from '../errors/errors.js';

/**
 * Public key parsing.
 *
 * Two encodings are accepted because two producers hand them out differently:
 * `govplane` writes PEM files, and the control-plane API returns base64 DER
 * SPKI. Requiring the caller to normalise between them would be a papercut with
 * no upside.
 */
export const parsePublicKey = (raw: string): KeyObject => {
  const value = raw.trim();

  if (value === '') {
    throw new BundleSignatureError(
      'The configured public key is empty.',
      'BUNDLE_SIGNATURE_CONFIG_ERROR',
    );
  }

  try {
    if (value.startsWith('-----')) {
      return createPublicKey(value);
    }
    return createPublicKey({
      key: Buffer.from(value, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch (cause) {
    throw new BundleSignatureError(
      `The configured public key could not be parsed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      'BUNDLE_SIGNATURE_CONFIG_ERROR',
      { cause },
    );
  }
};

const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Decodes a shared HMAC secret.
 *
 * The secret is 256 bits written as 64 hex characters, which is what
 * `govplane sign --hmac-secret` expects and what the control plane issues. A
 * secret of the wrong length is a configuration error worth naming precisely —
 * silently hashing a truncated key would "work" and verify nothing.
 */
export const parseHmacSecret = (raw: string): Buffer => {
  const value = raw.trim();

  if (!HEX_64.test(value)) {
    throw new BundleSignatureError(
      'The configured HMAC secret must be 64 hexadecimal characters (256 bits).',
      'BUNDLE_SIGNATURE_CONFIG_ERROR',
      { length: value.length },
    );
  }

  return Buffer.from(value, 'hex');
};
