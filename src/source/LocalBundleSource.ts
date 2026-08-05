import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BundleOrigin } from '../bundle/types.js';
import { BundleValidationError } from '../errors/errors.js';
import { verifyBundle, type VerificationKey } from '../verify/verifyBundle.js';
import type { BundleSource, LoadedBundle, SourceDescription } from './types.js';

/**
 * A bundle read from the local filesystem.
 *
 * This replaces 1.x "isolated mode" and its safe-bundle vocabulary. The
 * distinction that mattered there — control-plane-signed versus not — turned
 * out to be the wrong axis: what matters is whether a bundle verifies against
 * a key you configured, and that is the same question wherever the file came
 * from. A bundle built by `govplane build`, committed to a repository, baked
 * into a container image or dropped in by configuration management is the same
 * artifact to this source.
 *
 * The SDK never fetches it. If a bundle needs to arrive from a repository or an
 * object store, the application puts it on disk and points here — which keeps
 * every network protocol, credential and failure mode outside the SDK's trust
 * boundary.
 */

export interface LocalSourceOptions {
  bundlePath: string;
  key?: VerificationKey | undefined;
  allowUnsigned?: boolean;
  /**
   * Reload when the file changes on disk.
   *
   * Polls modification time rather than using `fs.watch`, which behaves
   * differently on every platform and misses atomic-rename writes — exactly how
   * `govplane build` writes a bundle.
   */
  watch?: { intervalMs?: number } | undefined;
}

const DEFAULT_WATCH_MS = 5000;

export class LocalBundleSource implements BundleSource {
  readonly origin: BundleOrigin = 'local';

  private readonly path: string;

  private readonly options: LocalSourceOptions;

  private timer: NodeJS.Timeout | null = null;

  private lastSignature: string | null = null;

  constructor(options: LocalSourceOptions) {
    this.options = options;
    this.path = resolve(options.bundlePath);
  }

  /** Identity of the file as it is now: changed content means a changed value. */
  private async fingerprint(): Promise<string> {
    const stats = await stat(this.path);
    return `${stats.mtimeMs}:${stats.size}`;
  }

  async load(): Promise<LoadedBundle> {
    // Baseline the file being read, here rather than on the first poll. A bundle
    // replaced between construction and that poll would otherwise be adopted as
    // the baseline and never loaded — the change lost for the life of the
    // process, not merely delayed. Deploying a new bundle as a service starts is
    // exactly when that happens.
    //
    // Recorded before the read, so a file that fails to parse or verify is not
    // retried on every tick, filling the log with the same error.
    try {
      this.lastSignature = await this.fingerprint();
    } catch {
      // Unreadable is reported by the read below, which says what went wrong.
    }

    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (cause) {
      throw new BundleValidationError(
        `The bundle could not be read: ${this.path}`,
        'BUNDLE_READ_ERROR',
        { cause },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new BundleValidationError(
        `The bundle is not valid JSON: ${this.path}`,
        'BUNDLE_PARSE_ERROR',
        { cause },
      );
    }

    const verification = verifyBundle(parsed, {
      origin: 'local',
      key: this.options.key,
      ...(this.options.allowUnsigned === undefined
        ? {}
        : { allowUnsigned: this.options.allowUnsigned }),
    });

    return { bundle: verification.bundle, verification, unchanged: false };
  }

  start(handlers: {
    onChange: (loaded: LoadedBundle) => void;
    onError: (error: unknown) => void;
  }): void {
    if (this.options.watch === undefined || this.timer !== null) {
      return;
    }

    const intervalMs = this.options.watch.intervalMs ?? DEFAULT_WATCH_MS;

    const poll = (): void => {
      void this.pollOnce(handlers);
    };

    this.timer = setInterval(poll, intervalMs);
    // Watching for policy changes must never be the reason a process stays
    // alive; an application closes the client when it is ready to exit.
    this.timer.unref?.();
  }

  /** Exposed for tests, which drive the poll rather than waiting on a timer. */
  async pollOnce(handlers: {
    onChange: (loaded: LoadedBundle) => void;
    onError: (error: unknown) => void;
  }): Promise<void> {
    let fingerprint: string;
    try {
      fingerprint = await this.fingerprint();
    } catch (error) {
      handlers.onError(error);
      return;
    }

    if (fingerprint === this.lastSignature) {
      return;
    }

    // Polled before anything was loaded, so there is no bundle to compare
    // against and nothing to report: take this file as the baseline. In normal
    // use the client loads at construction and this does not arise.
    if (this.lastSignature === null) {
      this.lastSignature = fingerprint;
      return;
    }

    // `load` records the new baseline itself, before reading, so a file that
    // cannot be parsed or verified is reported once rather than on every tick.
    try {
      handlers.onChange(await this.load());
    } catch (error) {
      handlers.onError(error);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  describe(): SourceDescription {
    return { origin: 'local', location: this.path };
  }
}
