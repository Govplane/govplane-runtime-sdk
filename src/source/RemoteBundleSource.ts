import type { BundleOrigin } from '../bundle/types.js';
import { BundleValidationError, HttpError } from '../errors/errors.js';
import { verifyBundle, type VerificationKey } from '../verify/verifyBundle.js';
import type { BundleSource, LoadedBundle, SourceDescription } from './types.js';

/**
 * A bundle fetched from Govplane Cloud.
 *
 * Optional by design: nothing in the SDK requires it, and an application that
 * never calls `createRemoteClient` needs no runtime key, no endpoint and no
 * account. What this adds over the local source is delivery — polling, ETag
 * revalidation and backoff — not trust. Verification is the same code path,
 * with one difference the FIPS decision requires: a cloud bundle must be
 * ECDSA-signed, because an HMAC secret would have to leave the HSM.
 */

export interface RemoteSourceOptions {
  baseUrl: string;
  runtimeKey: string;
  orgId: string;
  projectId: string;
  env: string;
  key?: VerificationKey | undefined;
  allowUnsigned?: boolean;
  timeoutMs?: number;
  userAgent?: string;
  poll?: {
    intervalMs?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    backoffJitter?: number;
    degradeAfterFailures?: number;
  };
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface RemoteState {
  etag: string | undefined;
  bundleVersion: number | undefined;
  updatedAt: string | undefined;
  consecutiveFailures: number;
  degraded: boolean;
  lastError: string | undefined;
}

const DEFAULTS = {
  intervalMs: 5000,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  backoffJitter: 0.2,
  degradeAfterFailures: 3,
  timeoutMs: 5000,
};

export class RemoteBundleSource implements BundleSource {
  readonly origin: BundleOrigin = 'remote';

  private readonly options: RemoteSourceOptions;

  private readonly fetchImpl: typeof fetch;

  private timer: NodeJS.Timeout | null = null;

  private stopped = false;

  private state: RemoteState = {
    etag: undefined,
    bundleVersion: undefined,
    updatedAt: undefined,
    consecutiveFailures: 0,
    degraded: false,
    lastError: undefined,
  };

  constructor(options: RemoteSourceOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  snapshot(): RemoteState {
    return { ...this.state };
  }

  private url(): string {
    const url = new URL(this.options.baseUrl);
    url.searchParams.set('orgId', this.options.orgId);
    url.searchParams.set('projectId', this.options.projectId);
    url.searchParams.set('env', this.options.env);
    return url.toString();
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: this.options.runtimeKey,
      'User-Agent': this.options.userAgent ?? 'govplane-runtime-sdk/2.x',
      ...extra,
    };
  }

  private async request(): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULTS.timeoutMs,
    );

    try {
      return await this.fetchImpl(this.url(), {
        method: 'GET',
        headers: this.headers(
          this.state.etag === undefined ? undefined : { 'If-None-Match': this.state.etag },
        ),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Extracts the bundle body from the response envelope.
   *
   * The control plane has served several shapes over time — bare, `{ data }`,
   * `{ data: { body } }`. Accepting all of them costs a few lines and avoids a
   * lockstep deployment between the runtime service and every installed SDK.
   */
  private static body(parsed: unknown): unknown {
    const candidates = [
      parsed,
      (parsed as { data?: unknown })?.data,
      (parsed as { data?: { body?: unknown } })?.data?.body,
      (parsed as { body?: unknown })?.body,
    ];
    return candidates.find(
      (candidate) => (candidate as { schemaVersion?: unknown })?.schemaVersion === 1,
    ) ?? parsed;
  }

  async load(): Promise<LoadedBundle> {
    let response: Response;
    try {
      response = await this.request();
    } catch (cause) {
      this.recordFailure(cause);
      throw cause;
    }

    if (response.status === 304) {
      this.recordSuccess();
      throw new BundleValidationError(
        'The bundle is unchanged; there is nothing to load.',
        'BUNDLE_NOT_MODIFIED',
      );
    }

    if (!response.ok) {
      const error = new HttpError(
        `Fetching the bundle failed (${response.status})`,
        response.status,
      );
      this.recordFailure(error);
      throw error;
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (cause) {
      const error = new BundleValidationError(
        'The response from Govplane Cloud is not valid JSON.',
        'BUNDLE_PARSE_ERROR',
        { cause },
      );
      this.recordFailure(error);
      throw error;
    }

    const verification = verifyBundle(RemoteBundleSource.body(parsed), {
      origin: 'remote',
      key: this.options.key,
      ...(this.options.allowUnsigned === undefined
        ? {}
        : { allowUnsigned: this.options.allowUnsigned }),
    });

    const etag = response.headers.get('etag');
    const version = response.headers.get('x-gp-bundle-version');
    this.state.etag = etag ?? this.state.etag;
    this.state.bundleVersion = version === null
      ? verification.bundle.bundleVersion
      : Number(version);
    this.state.updatedAt = response.headers.get('x-gp-updated-at') ?? this.state.updatedAt;
    this.recordSuccess();

    return { bundle: verification.bundle, verification, unchanged: false };
  }

  private recordSuccess(): void {
    this.state.consecutiveFailures = 0;
    this.state.degraded = false;
    this.state.lastError = undefined;
  }

  private recordFailure(error: unknown): void {
    this.state.consecutiveFailures += 1;
    this.state.lastError = error instanceof Error ? error.message : String(error);
    const threshold = this.options.poll?.degradeAfterFailures ?? DEFAULTS.degradeAfterFailures;
    if (this.state.consecutiveFailures >= threshold) {
      // Degraded means "serving the last good bundle and no longer confident it
      // is current". It never means "serving nothing" — the cached bundle stays
      // in force, which is the entire reason it is cached.
      this.state.degraded = true;
    }
  }

  /** Exponential backoff with jitter, so a fleet does not retry in lockstep. */
  nextDelayMs(): number {
    const poll = this.options.poll ?? {};
    const interval = poll.intervalMs ?? DEFAULTS.intervalMs;

    if (this.state.consecutiveFailures === 0) {
      return interval;
    }

    const base = poll.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
    const max = poll.backoffMaxMs ?? DEFAULTS.backoffMaxMs;
    const jitter = poll.backoffJitter ?? DEFAULTS.backoffJitter;

    const exponential = Math.min(max, base * 2 ** (this.state.consecutiveFailures - 1));
    const spread = exponential * jitter;
    return Math.max(0, Math.round(exponential + (Math.random() * 2 - 1) * spread));
  }

  start(handlers: {
    onChange: (loaded: LoadedBundle) => void;
    onError: (error: unknown) => void;
  }): void {
    if (this.timer !== null || this.stopped) {
      return;
    }

    // Each tick schedules the next one when it finishes, rather than running on
    // a fixed interval. A slow or hanging fetch therefore cannot stack requests
    // on top of each other, and the backoff delay is recomputed from the
    // failure count each time.
    const schedule = (): void => {
      if (this.stopped) {
        return;
      }

      this.timer = setTimeout(() => {
        void (async () => {
          try {
            handlers.onChange(await this.load());
          } catch (error) {
            // 304 is the steady state, not a problem worth reporting.
            if ((error as { code?: string }).code !== 'BUNDLE_NOT_MODIFIED') {
              handlers.onError(error);
            }
          } finally {
            schedule();
          }
        })();
      }, this.nextDelayMs());

      // Polling for policy changes must never be the reason a process stays
      // alive; an application closes the client when it is ready to exit.
      this.timer.unref?.();
    };

    schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  describe(): SourceDescription {
    // The runtime key is never included — this string reaches logs and status
    // output.
    return { origin: 'remote', location: this.options.baseUrl };
  }
}
