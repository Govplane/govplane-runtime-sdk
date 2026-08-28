import { ConfigurationError } from '../errors/errors.js';
import { RemoteBundleSource, type RemoteSourceOptions } from '../source/RemoteBundleSource.js';
import { createClient, type ClientOptions, type GovplaneClient } from './GovplaneClient.js';
import type { ClientObserver } from '../observe/attach.js';
import type { IngestionSwitches } from '../observe/ingestion.js';

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

  /**
   * Report telemetry to Govplane Cloud.
   *
   * Absent, nothing changes: no timer is started, no module is loaded, and the
   * client returned is exactly the one earlier versions returned. The module is
   * pulled in dynamically so an application that never sets this does not carry
   * its code.
   *
   * Present, `enabled` and the three `ingest*` switches decide what is actually
   * sent — and each is off until named. See `IngestionSwitches`.
   */
  observe?: ObserveConfig | undefined;
}

export interface ObserveConfig extends IngestionSwitches {
  /**
   * The ingest host for this tenant, e.g.
   * `https://<tenantId>.ingest.govplane.com`.
   *
   * Separate from `baseUrl` on purpose: ingest is a distinct private host with
   * a distinct grant, so a key used there cannot read policy data.
   */
  endpoint: string;
  /** Names this service in the series. Defaults to the project id. */
  source?: string | undefined;
  /** Stable per process. Required for fleet-aware alert conditions. */
  instanceId?: string | undefined;
  /** Seconds per rollup bucket. Defaults to 300. */
  rollupSeconds?: number | undefined;
  /** Ceiling on distinct decision series held in memory. Defaults to 1000. */
  maxSeries?: number | undefined;
  /**
   * Tag decision counters with this instance. Off by default: it multiplies
   * stored series by fleet size. Health metrics always carry it.
   */
  perInstance?: boolean | undefined;
  /** Receives every telemetry failure. Telemetry never throws at the caller. */
  onError?: ((error: unknown) => void) | undefined;

}

const REQUIRED = ['baseUrl', 'runtimeKey', 'orgId', 'projectId', 'env'] as const;

export const createRemoteClient = async (
  config: RemoteClientConfig,
): Promise<GovplaneClient & { observe?: ClientObserver }> => {
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

  const clientOptions: ClientOptions = {
    ...(config.engine === undefined ? {} : { engine: config.engine }),
    ...(config.trace === undefined ? {} : { trace: config.trace }),
    ...(config.onError === undefined ? {} : { onError: config.onError }),
    ...(config.onDecision === undefined ? {} : { onDecision: config.onDecision }),
  };

  /**
   * `enabled: false` returns before the module is even resolved.
   *
   *
   * Checked here rather than after the import so that switching ingestion off
   * costs exactly what leaving it unconfigured costs: no chunk fetched, no
   * timer, no allocation. A kill switch that still loaded the thing it kills
   * would be a poor kill switch.
   */
  if (config.observe === undefined || !config.observe.enabled) {
    return createClient(source, initial, clientOptions);
  }

  // Loaded only on this branch. A static import would place the observability
  // module in the main entry point's graph, so every application would ship it
  // whether or not it reports anything — the property a separate package used
  // to guarantee for free.
  const { createClientObserver } = await import('../observe/attach.js');
  const { resolveIngestion } = await import('../observe/ingestion.js');

  const ingestion = resolveIngestion(config.observe);

  /**
   * Ingestion on, and nothing named to send.
   *
   * Reported rather than tolerated. Somebody in this state has configured an
   * endpoint, a source and a master switch, and will reasonably expect data to
   * appear; finding out a week later that no category was ever turned on is the
   * kind of quiet nothing this codebase spends most of its comments avoiding.
   */
  if (ingestion.inert) {
    config.observe.onError?.(new Error(
      'Govplane: observe.enabled is true but no category is, so nothing will be sent. '
      + 'Set ingestDecisionTracing, ingestCustomMetrics or ingestPerformanceMetrics.',
    ));
  }

  // Declared before the client exists so the hook can be handed to the engine,
  // then filled in once there is a client to read the bundle version from.
  let client: GovplaneClient | undefined;

  const observed = createClientObserver(
    {
      endpoint: config.observe.endpoint,
      runtimeKey: config.runtimeKey,
      projectId: config.projectId,
      env: config.env,
      source: config.observe.source ?? config.projectId,
      instanceId: config.observe.instanceId,
      decisions: {
        ...(config.observe.rollupSeconds === undefined
          ? {}
          : { rollupSeconds: config.observe.rollupSeconds }),
        ...(config.observe.maxSeries === undefined
          ? {}
          : { maxSeries: config.observe.maxSeries }),
        ...(config.observe.perInstance === undefined
          ? {}
          : { perInstance: config.observe.perInstance }),
      },
      ...(config.observe.onError === undefined
        ? {}
        : { onError: (error: unknown) => config.observe?.onError?.(error) }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      ingestion,
    },
    () => client?.status().bundleVersion,
    () => {
      const status = client?.status();
      if (!status) return undefined;
      return { bundleVersion: status.bundleVersion, loadedAt: status.loadedAt };
    },
  );

  // Composed, never replaced: a caller's own decision hook keeps working.
  const callerHook = clientOptions.onDecision;
  client = createClient(source, initial, {
    ...clientOptions,
    /**
     * Not attached at all when decision tracing is off.
     *
     * The alternative — attach it and discard inside — would leave a function
     * call on the evaluation path doing nothing, for every evaluation, for the
     * life of the process. Declining to register the hook keeps the promise
     * that an unused stream costs nothing.
     */
    ...(ingestion.decisions
      ? {
        onDecision: (decision: Parameters<NonNullable<typeof callerHook>>[0]) => {
          callerHook?.(decision);
          observed.onDecision(decision);
        },
      }
      : {}),
  });

  return {
    ...client,
    close() {
      // Ships what is buffered, but never blocks shutdown on a slow endpoint.
      void observed.handle.close();
      client?.close();
    },
    observe: observed.handle,
  };
};
