# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-08-02

A rebuild around one verification path and two bundle sources. The evaluation
engine is carried over with a single deliberate change to how policy defaults are
scoped (see **Changed**); everything around it is new.

### Fixed

- **Bundle signatures are verified over the bytes that are actually signed.**
  1.x had two verification paths and neither used the canonical projection that
  `gp-worker` and `@govplane/cli` sign: one hashed the whole response body, the
  other the whole document minus `signature`. Both are replaced by a single
  implementation, asserted byte-for-byte against fixtures shared with the CLI
  and the control plane (`specs/fixtures/signing/`).
- A signed bundle with no configured verification key is no longer treated as
  acceptable. A signature nobody checked proves nothing.
- Context validation no longer defaults to enforcing the engine's seven-key
  sample allow-list, which rejected the very keys real bundles read. A policy is
  enforced when the application configures one.

### Added

- `createLocalClient()` — evaluates a bundle from disk with no account, no
  credentials and no network. File watching is opt-in through `watch: {}`;
  without it the bundle is read once, at construction. A failed reload leaves
  the previous bundle in force. The change baseline is taken at load rather than
  on the first poll, so a bundle replaced while the process is starting is
  picked up rather than mistaken for the starting state.
- `createRemoteClient()` — Govplane Cloud, with polling, ETag revalidation,
  jittered backoff and degraded-mode reporting.
- One `verifyBundle()` covering structure, checksum and signature for both
  sources, distinguishing verified / unsigned / missing / unverified rather than
  collapsing them to a boolean.
- `validateBundle()` with `scope: 'required' | 'optional'`, sharing error codes
  with `govplane validate`.
- Exported canonicalisation — `canonicalPayload`, `computeChecksum`,
  `projectCanonicalBundle`, `sortKeysDeep`.

### Changed

- **A policy's default now applies only to targets that policy governs.** In 1.x
  every policy contributed its default to every request, so one deny-by-default
  policy denied every target in the bundle — including targets another policy
  explicitly allowed, because deny outranks allow. A bundle with a
  `login-protection` policy allowing by default and an unrelated
  `refund-control` policy denying by default denied logins.

  A policy governs a target when one of its rules names that target. Scope is
  read from the rule's target alone, before status and condition, so a disabled
  rule or one whose `when` is false still keeps its policy in scope — turning a
  rule off cannot swap the policy's default for the global one. A policy with no
  rules governs nothing.

  Targets no policy governs still deny by default, so nothing becomes more
  permissive that was not already allowed by a policy written to allow it.
- **Ed25519 is no longer accepted.** It was required by the 1.x safe-bundle
  verifier, produced by nothing, and cannot be produced by AWS KMS, so it can
  never sit behind a FIPS 140-3 Level 3 signing path. Rejected with a distinct
  code naming the replacement.
- **HMAC_SHA256 is accepted from local bundles only.** Verifying HMAC means
  holding the signing secret; a cloud signature comes from a key that never
  leaves the HSM.
- Unsigned bundles require an explicit `allowUnsigned: true`.
- `orgId` and `projectId` are required for remote clients only.
- "Safe bundles" and isolated mode are replaced by local bundles. A local bundle
  is a source you choose, not a fallback you switch into.
- `signing:` is now `verify:`; poll and backoff options moved under `poll: {}`.
- `ContextPolicy` requires only `allowedKeys`; the implementation always
  defaulted the rest.

### Unchanged

- `createPolicyEngine`, `formatTrace`, every decision and trace type, and all
  engine options. Effect precedence, priority ordering, throttle strictness,
  condition operators and deny-by-default are ported verbatim; the one departure
  is default scoping, above. `govplane simulate` asserts runtime parity against
  the engine, and its full suite passes against this release.

### Migration

See [`docs/migration.md`](docs/migration.md).
