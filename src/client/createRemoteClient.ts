import { ConfigurationError } from '../errors/errors.js';
import { RemoteBundleSource, type RemoteSourceOptions } from '../source/RemoteBundleSource.js';
import { createClient, type ClientOptions, type GovplaneClient } from './GovplaneClient.js';

/**
 * A client that fetches its bundle from Govplane Cloud.
 *
 * Everything this needs — endpoint, runtime key, scope — is required here and
 * nowhere else. A local client asks for none of it, which is the structural
 * expression of "the runtime does not depend on Govplane infrastructure".
 */

export interface RemoteClientConfig extends ClientOptions {
  baseUrl: string;
  runtimeKey: string;
  /** Scope addresses the bundle within the control plane. */
  orgId: string;
  projectId: string;
  env: string;

  /**
   * The key cloud signatures are verified against.
   *
   * `ECDSA_SHA_256` only. A cloud bundle is signed inside a FIPS 140-3 Level 3
   * HSM by a key that never leaves it; HMAC would require sharing the secret,
   * which defeats that. See `specs/compliance/fips-140-3.md`.
   */
  verify?: { algorithm: 'ECDSA_SHA_256'; publicKey: string } | undefined;

  /** Accept an unverified bundle. Strongly discouraged for a remote source. */
  allowUnsigned?: boolean;

  timeoutMs?: number;
  userAgent?: string;
  poll?: RemoteSourceOptions['poll'];
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

const REQUIRED = ['baseUrl', 'runtimeKey', 'orgId', 'projectId', 'env'] as const;

export const createRemoteClient = async (
  config: RemoteClientConfig,
): Promise<GovplaneClient> => {
  const missing = REQUIRED.filter((field) => {
    const value = config[field];
    return typeof value !== 'string' || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new ConfigurationError(
      `A remote client requires: ${missing.join(', ')}. To evaluate a bundle from disk `
      + 'instead, use createLocalClient, which needs none of them.',
      'INVALID_CONFIGURATION',
      { missing },
    );
  }

  if (config.verify === undefined && config.allowUnsigned !== true) {
    throw new ConfigurationError(
      'No verification key was configured for a remote bundle. Pass verify with the '
      + 'ECDSA public key, or allowUnsigned: true to accept an unverified bundle.',
      'INVALID_CONFIGURATION',
    );
  }

  const options: RemoteSourceOptions = {
    baseUrl: config.baseUrl,
    runtimeKey: config.runtimeKey,
    orgId: config.orgId,
    projectId: config.projectId,
    env: config.env,
    key: config.verify,
    ...(config.allowUnsigned === undefined ? {} : { allowUnsigned: config.allowUnsigned }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.userAgent === undefined ? {} : { userAgent: config.userAgent }),
    ...(config.poll === undefined ? {} : { poll: config.poll }),
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  };

  const source = new RemoteBundleSource(options);
  const initial = await source.load();

  return createClient(source, initial, {
    ...(config.engine === undefined ? {} : { engine: config.engine }),
    ...(config.trace === undefined ? {} : { trace: config.trace }),
    ...(config.onError === undefined ? {} : { onError: config.onError }),
  });
};
