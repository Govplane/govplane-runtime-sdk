# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-08-22

Additive. Every existing call site behaves exactly as it did in 2.1.0, and the
whole 2.1.0 test suite passes untouched. Nothing below is loaded unless you
configure it.

### Added

- **Ingestion switches on `observe`.** Data ingestion is metered and billed, so
  what leaves your process is something you name rather than something that
  follows from configuring an endpoint:

  ```ts
  observe: {
    endpoint: 'https://<tenantId>.ingest.govplane.com',
    enabled: true,
    ingestDecisionTracing: true,     // what your policies decided
    ingestCustomMetrics: true,       // what your application reports
    ingestPerformanceMetrics: false, // what this process is doing
  }
  ```

  `enabled` is required rather than defaulted. Configuring an ingest endpoint is
  not the same as consenting to be billed for what goes to it, and a flag
  defaulting either way would make one of those two things happen silently.

  `enabled: true` honours the categories exactly as written, each **off** until
  named — a master switch that turned everything on by itself would be a cost
  control that increases costs. `enabled: false` sends nothing whatever else is
  set, and returns before the observability module is loaded: no chunk fetched,
  no timer, no allocation.

  `ingestPerformanceMetrics` is the expensive one. Its metrics are per-instance
  by nature, so the cost scales with replica count rather than with metric
  count. It also takes `{ intervalSeconds }`.

  The engine's `onDecision` hook is not registered at all when decision tracing
  is off, so an unused stream costs nothing on the evaluation path. A caller's
  own `onDecision` is unaffected.

  Calling `client.observe.event()`, `.metric()` or `.record()` with
  `ingestCustomMetrics` off records nothing and raises one message through
  `onError`. It never throws, and it warns **once per method** rather than once
  per call — `event` is designed to be called at request rate, and a warning per
  call would be a worse outage than the one it reports. Enabling ingestion with
  no category raises once at construction.

- **`onDecision`** on every client, local or remote. Fires on each evaluation,
  unsampled, through both `evaluate()` and `evaluateWithTrace()`:

  ```ts
  createLocalClient({ bundlePath, allowUnsigned: true,
    onDecision: (d) => metrics.increment('policy.decision', { outcome: d.decision }),
  });
  ```

  The counting companion to `trace.onDecisionTrace`, and deliberately a
  different thing. A trace carries full detail, so it is sampled and budgeted —
  `evaluate()` emits none at all and `evaluateWithTrace()` emits 1% by default.
  That describes decisions but cannot count them. `onDecision` is the reverse:
  cheap, complete, and carrying only identifiers.

  It receives the decision **before** output shaping, so `policyKey` and
  `ruleId` are present even where the call site asked for a bare boolean via
  `asBoolean`. It runs on the hot path; anything thrown is swallowed rather than
  allowed to fail an evaluation.

  Generic and vendor-neutral: point it at Prometheus, StatsD or a log line. No
  account required.

- **Observability for Govplane Cloud subscribers**, via a new `observe` block on
  `createRemoteClient`:

  ```ts
  observe: {
    endpoint: 'https://<tenantId>.ingest.govplane.com',
    source: 'checkout-api',
    healthMonitor: true,
  }
  ```

  Decisions are aggregated in-process and shipped as counts, keyed by policy,
  rule, outcome, reason and bundle version, on a wall-clock-aligned 300-second
  interval. One evaluation costs a map increment; one interval costs a handful
  of data points regardless of traffic.

  **Nothing from the evaluation input is sent** — not the context, not the
  target, not a user id. There is no setting that adds it. The identifiers
  describe which rule decided, never who it decided about.

  Guarantees, each with a test: it cannot slow `evaluate()`, cannot throw at the
  application, cannot grow without bound, cannot keep the process alive, and
  cannot become a dependency of evaluation. If the endpoint is unreachable or
  the project's quota is exhausted, policies keep evaluating and only telemetry
  stops.

  `client.observe.flush()` ships the current bucket; `close()` stops timers and
  makes a best-effort final flush without blocking on a slow endpoint.

- **Custom application metrics** on `client.observe`, so a rule can correlate a
  policy's behaviour with its consequences:

  ```ts
  client.observe?.event('payment.failed', {
    category: 'error_rate',
    tags: { provider: 'stripe' },
  });
  client.observe?.metric('checkout.queue_depth', depth, { unit: 'count' });
  ```

  `event` counts and sums; `metric` measures and reduces (`last` by default, or
  `avg`/`min`/`max`/`sum`). Both aggregate on the decision interval and ship in
  the same request, so calling `event()` per request costs a map increment
  rather than a network call.

  Limits — 10 tags, 200-character values, 500 distinct series — are enforced
  client-side and deliberately tighter than gp-data's. gp-data validates a batch
  all-or-nothing, so one malformed custom point would otherwise discard every
  decision counter travelling with it. Rejected points are reported through
  `onError` with the reason; the rest of the interval still ships.

  Past the series ceiling new series are **refused** rather than folded into an
  overflow bucket. Decision series names come from the bundle and are bounded by
  it; custom names come from the application, so an unbounded set is a caller bug
  that folding would hide.

- **`client.observe.record()`** for correlated occurrences — the drill-down that
  aggregated metrics cannot express:

  ```ts
  const { trace } = client.evaluateWithTrace(input, { level: 'full' });
  client.observe?.record('payment declined at capture', {
    traceId: trace?.traceId, level: 'error', code: 'card_declined',
  });
  ```

  A trace id is high-cardinality and cannot be a tag on a summed series, so this
  keeps whole entries and ships them to the log endpoint, in their own request
  sent before the metric batch.

  It does **not** aggregate: one call is one stored entry. Bounded hard at 200
  records per interval, 1,000-character messages and 8 KB of metadata, because a
  `record()` left in a hot path would otherwise consume a project's storage
  quota. Overflow is reported once per interval, not once per dropped record,
  and the message says to use `event()` instead.

- **`healthMonitor`**, off by default, sampling process resource and runtime
  health every 60 seconds: resident memory, memory against the *container*
  limit, heap ratio, CPU, event-loop lag p99, uptime, and how stale the bundle
  in force is.

  The metric names are a contract shared across Govplane's SDKs, so an alert
  rule written once behaves the same whether the service is Node or Python.

  Opt-in because health metrics are inherently per-instance: their storage cost
  scales with replica count, which should be a decision rather than a discovery.
  `memory.limit_ratio` is omitted rather than guessed where no container limit
  can be read — `os.totalmem()` reports the host's memory inside a container,
  which would look plausible and be wrong.

- **`@govplane/runtime-sdk/observe`** subpath export, for callers driving the
  aggregator or health sampler themselves. Importing the subpath is the only way
  to load this code; an application that never imports it does not carry it.

### Fixed

- `createRemoteClient` silently dropped a caller-supplied `onDecision`, since it
  copied its client options field by field and had no branch for it. Found by an
  end-to-end test rather than a unit test, because each half worked in
  isolation.

### Notes

`evaluateWithTrace` is unchanged and remains the way to obtain a trace as a
return value. `onDecision` does not replace it: it is a side effect that leaves
every return type alone, which is why counting could be added without touching
a single existing signature.

## [2.1.0] - 2026-08-07

Additive. `evaluate(input)` with one argument returns exactly what it did in
2.0.0; every existing test passes untouched.

### Added

- **`asBoolean`, `asBinary` and `effectOnly`** on `evaluate`, for call sites that
  branch on the outcome and never read the rest:

  ```ts
  if (!govplane.evaluate({ target, context }, { asBoolean: true })) return forbidden();
  ```

  `allow` and `custom` are true; `deny`, `kill_switch` and **`throttle`** are
  false. Throttle reduces to false despite permitting the action, because a
  boolean cannot carry the limit and a caller seeing `true` would proceed at an
  unbounded rate — failing open on the effect that exists to bound it. Anything
  acting on throttles must read the full decision.

  The return type follows the option, so none of the three needs narrowing.
  Setting more than one throws `ConfigurationError` (`INVALID_EVALUATE_OPTIONS`)
  rather than silently choosing. `evaluateWithTrace` is unaffected — a trace
  beside a bare boolean would have nothing to explain.

- **Evaluating a rule by name**, instead of by target:

  ```ts
  govplane.evaluate({ ruleId: 'deny-after-five', policyKey: 'login-protection', context });
  ```

  Target matching is skipped; `context` still applies. If the rule does not fire,
  its owning policy's default applies — so naming a rule and naming its target
  give the same answer, which the suite asserts directly rather than by
  inspection.

  Rule ids are unique within a policy but not across a bundle, so a bare `ruleId`
  resolves to the first match **in bundle order**; `policyKey` removes the
  ambiguity. A rule or policy that is not there throws the new
  `RuleNotFoundError` (`RULE_NOT_FOUND`) rather than returning a denial: naming
  something absent is a caller mistake, and reporting it as `deny` would leave a
  typo looking like a decision nobody investigates.

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
