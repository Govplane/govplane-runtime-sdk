import { ConfigurationError } from '../errors/errors.js';
import { LocalBundleSource, type LocalSourceOptions } from '../source/LocalBundleSource.js';
import type { VerificationKey } from '../verify/verifyBundle.js';
import { createClient, type ClientOptions, type GovplaneClient } from './GovplaneClient.js';

/**
 * A client that evaluates a bundle from the local filesystem.
 *
 * No account, no credentials, no network. This is the path that makes the
 * runtime genuinely free of Govplane infrastructure: build a bundle with
 * `govplane build`, sign it with `govplane sign`, ship it however you ship
 * configuration, and point here.
 */

export interface LocalClientConfig extends ClientOptions {
  /** Path to the bundle JSON. Relative paths resolve from the process cwd. */
  bundlePath: string;

  /**
   * The key the bundle's signature is verified against.
   *
   * `ECDSA_SHA_256` takes the public key (PEM or base64 DER SPKI);
   * `HMAC_SHA256` takes the 64-hex-character shared secret.
   */
  verify?: VerificationKey | undefined;

  /**
   * Evaluate a bundle whose signature cannot be checked.
   *
   * Required to load an unsigned bundle, and to load a signed one with no key
   * configured. Off by default: a policy bundle decides who may do what, and
   * running one of unknown provenance should be a decision somebody made on
   * purpose and can find again in code review.
   */
  allowUnsigned?: boolean;

  /** Reload when the file changes. Omit to load once. */
  watch?: { intervalMs?: number } | undefined;
}

export const createLocalClient = async (
  config: LocalClientConfig,
): Promise<GovplaneClient> => {
  if (typeof config.bundlePath !== 'string' || config.bundlePath.trim() === '') {
    throw new ConfigurationError('bundlePath is required.', 'INVALID_CONFIGURATION');
  }

  if (config.verify === undefined && config.allowUnsigned !== true) {
    throw new ConfigurationError(
      'No verification key was configured. Pass verify with a key, or allowUnsigned: true '
      + 'to evaluate a bundle whose provenance is not checked.',
      'INVALID_CONFIGURATION',
    );
  }

  const options: LocalSourceOptions = {
    bundlePath: config.bundlePath,
    key: config.verify,
    ...(config.allowUnsigned === undefined ? {} : { allowUnsigned: config.allowUnsigned }),
    ...(config.watch === undefined ? {} : { watch: config.watch }),
  };

  const source = new LocalBundleSource(options);
  const initial = await source.load();

  return createClient(source, initial, {
    ...(config.engine === undefined ? {} : { engine: config.engine }),
    ...(config.trace === undefined ? {} : { trace: config.trace }),
    ...(config.onError === undefined ? {} : { onError: config.onError }),
  });
};
