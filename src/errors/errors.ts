/**
 * SDK error types.
 *
 * Every error carries a stable `code`. Messages are written for a human reading
 * a log at three in the morning; codes are what application code and alerting
 * should match on, and they do not change when the wording improves.
 */

export class GovplaneError extends Error {
  readonly code: string;

  readonly details: unknown;

  constructor(message: string, code = 'GP_ERROR', details?: unknown) {
    super(message);
    this.name = 'GovplaneError';
    this.code = code;
    this.details = details;
  }
}

export class HttpError extends GovplaneError {
  readonly status: number;

  readonly headers: Record<string, string> | undefined;

  constructor(
    message: string,
    status: number,
    headers?: Record<string, string>,
    details?: unknown,
  ) {
    super(message, 'HTTP_ERROR', details);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

/**
 * A bundle was structurally invalid, or its checksum did not match.
 *
 * Raised before any signature check: a document that is not a well-formed
 * bundle cannot be meaningfully verified, and reporting "bad signature" for a
 * malformed file sends the reader looking in the wrong place.
 */
export class BundleValidationError extends GovplaneError {
  constructor(message: string, code = 'BUNDLE_INVALID', details?: unknown) {
    super(message, code, details);
    this.name = 'BundleValidationError';
  }
}

/**
 * A bundle's cryptographic signature could not be verified.
 *
 * Covers a mismatched signature, an algorithm this SDK will not accept from the
 * source in question, a missing signature where one is required, and malformed
 * key material.
 */
export class BundleSignatureError extends GovplaneError {
  constructor(message: string, code = 'BUNDLE_SIGNATURE_ERROR', details?: unknown) {
    super(message, code, details);
    this.name = 'BundleSignatureError';
  }
}

/**
 * A rule addressed by name is not in the bundle.
 *
 * Thrown rather than returned as a denial, unlike every other evaluation-time
 * problem. Those describe a policy outcome; this describes a caller naming
 * something that does not exist, and reporting it as `deny` would hide a typo as
 * a decision nobody investigates.
 */
export class RuleNotFoundError extends GovplaneError {
  constructor(message: string, details?: unknown) {
    super(message, 'RULE_NOT_FOUND', details);
    this.name = 'RuleNotFoundError';
  }
}

/** Configuration that cannot produce a working client. */
export class ConfigurationError extends GovplaneError {
  constructor(message: string, code = 'INVALID_CONFIGURATION', details?: unknown) {
    super(message, code, details);
    this.name = 'ConfigurationError';
  }
}

/**
 * Retained so code written against the 1.x SDK keeps compiling.
 *
 * @deprecated Use {@link BundleValidationError}. The "safe bundle" concept was
 * replaced by local bundles, which may come from any source and are verified
 * identically.
 */
export class SafeBundleValidationError extends BundleValidationError {
  constructor(message: string, code = 'BUNDLE_INVALID', details?: unknown) {
    super(message, code, details);
    this.name = 'SafeBundleValidationError';
  }
}
