import type { BundleOrigin, RuntimeBundle } from '../bundle/types.js';
import type { VerifiedBundle } from '../verify/verifyBundle.js';

/**
 * Where bundles come from.
 *
 * The whole point of the 2.0 architecture: local and remote are two
 * implementations of one interface, and everything downstream — validation,
 * verification, evaluation — is shared. A source produces bytes and says where
 * they came from; it decides nothing about trust.
 */

export interface LoadedBundle {
  bundle: RuntimeBundle;
  verification: VerifiedBundle;
  /** Set when the source knows the bundle has not changed since the last load. */
  unchanged: boolean;
}

export interface SourceDescription {
  origin: BundleOrigin;
  /** A path or URL, for status output and logs. Never contains credentials. */
  location: string;
}

export interface BundleSource {
  readonly origin: BundleOrigin;

  /** Fetches and verifies. Throws if the bundle cannot be trusted. */
  load(): Promise<LoadedBundle>;

  /**
   * Begins watching for changes, where the source supports it. The callback
   * receives every successfully verified reload; a failed reload is reported
   * through `onError` and the previously loaded bundle stays in force.
   */
  start?(handlers: {
    onChange: (loaded: LoadedBundle) => void;
    onError: (error: unknown) => void;
  }): void;

  stop(): void;

  describe(): SourceDescription;
}
