# @govplane/runtime-sdk

Evaluate Govplane policy bundles in your application — from a file on disk, or
from Govplane Cloud.

Eliminate 'magic ifs' and control your application in a predictable, controlled, secure and auditable way.

```bash
npm install @govplane/runtime-sdk
```

Zero runtime dependencies. Node.js 22.23.4+, 24.22.1+ or 26.12.1+ — the
releases that fix [CVE-2026-111497](#nodejs-versions).

## ESM and CommonJS

The package ships **one** build, in ESM. Both module systems load that same file:

```js
import { createLocalClient } from '@govplane/runtime-sdk';        // ESM
const { createLocalClient } = require('@govplane/runtime-sdk');   // CommonJS
```

`require()` of an ES module works without flags on every Node.js release the
SDK accepts. There is no separate CommonJS build on purpose: a
package that ships both can end up loaded twice in one process, and then classes
are no longer shared — an error thrown by one copy fails an `instanceof` check
against the other. With a single file that cannot happen, and the SDK's error
classes are meant to be checked:

```js
if (error instanceof BundleValidationError) { /* … */ }
```

On Node older than 20.19, `require()` fails with `ERR_REQUIRE_ESM`. Load it
through a dynamic import instead:

```js
async function start() {
  const { createLocalClient } = await import('@govplane/runtime-sdk');
  return createLocalClient({ bundlePath: './policy-bundle.json' });
}
```

TypeScript users compiling to CommonJS need TypeScript 5.8 or later with
`"module": "nodenext"` for `require()` of an ES module to typecheck.

## Node.js versions

| Line | Minimum |
|---|---|
| 22.x | 22.23.4 |
| 24.x | 24.22.1 |
| 26.x | 26.12.1 |

These are the 21 October 2026 security releases, which fix
[CVE-2026-111497](https://nodejs.org/en/blog/vulnerability/), a remote code
execution flaw in Node.js's Brotli decompression. The remote client and the observability transport use the
global `fetch`, which decompresses a `Content-Encoding: br` response
automatically. On an unpatched runtime, a response from a hostile or
intercepted endpoint can therefore reach the vulnerable code without any
Brotli call of yours. Node.js 20, 25 and older lines are end of life and will
not receive a fix, so the SDK does not support them.

The SDK does not check the version at runtime. `engines` declares the range,
so set `engine-strict=true` in your `.npmrc` if you want installs on other
versions to fail.

## Two ways in

### Local — no account, no credentials, no network

```ts
import { createLocalClient } from '@govplane/runtime-sdk';

const govplane = await createLocalClient({
  bundlePath: './policy-bundle.json',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey: process.env.GOVPLANE_PUBLIC_KEY },
});

const decision = govplane.evaluate({
  target: { service: 'auth', resource: 'login', action: 'authenticate' },
  context: { failedAttempts: 6 },
});

if (decision.decision === 'deny') {
  // …
}
```

Build the bundle with the CLI, sign it, ship it however you ship configuration:

```bash
npm install --global @govplane/cli @govplane/toolkit
govplane build --signed
```

Nothing about this path touches Govplane infrastructure — at build time or at
runtime.

### Remote — Govplane Cloud

```ts
import { createRemoteClient } from '@govplane/runtime-sdk';

const govplane = await createRemoteClient({
  baseUrl: process.env.GOVPLANE_URL,
  runtimeKey: process.env.GOVPLANE_RUNTIME_KEY,
  orgId: 'org_…',
  projectId: 'proj_…',
  env: 'prod',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey: process.env.GOVPLANE_PUBLIC_KEY },
  poll: { intervalMs: 5000 },
});
```

Adds delivery — polling, ETag revalidation, backoff, degraded-mode reporting.
Everything else is the same code.

## The client

Both factories return the same interface:

```ts
govplane.evaluate({ target, context });
govplane.evaluate({ ruleId, context });                    // one named rule
govplane.evaluate({ target, context }, { asBoolean: true }); // just yes or no
govplane.evaluateWithTrace({ target, context }, { level: 'full' });
govplane.bundle();     // the bundle currently in force
govplane.status();     // origin, version, checksum, signature, policy count
await govplane.reload();
govplane.close();
```

A client always holds a verified bundle: the first load happens before
construction, so `evaluate()` can never be called against nothing.

## Decisions

```ts
{ decision: 'allow' | 'deny' | 'kill_switch' | 'requires_approval' | 'throttle' | 'custom',
  reason: 'rule' | 'default' | 'signal_missing',
  policyKey?: string,
  ruleId?: string }
```

`ruleId` is present when a rule decided it, and absent when a policy default
did. Effect precedence is
`kill_switch > deny > requires_approval > throttle > allow > custom`, then
priority descending — a `kill_switch` at priority 1 beats a `deny` at 100.

When nothing matches and no policy offers a default, the decision is
**deny by default**. `reason: 'signal_missing'` means the bundle was never
consulted, because a signal the client declared it depends on was not supplied
— see [Required signals](#required-signals).

`requires_approval` gates an action on a human. It outranks anything that
would have let the action proceed, and carries whatever the rule said about
the approval it wants:

```ts
{ decision: 'requires_approval', reason: 'rule', policyKey: 'data-handling', ruleId: 'r_export',
  approval?: { reason?: string, approvers?: string[], expiresInSeconds?: number } }
```

The SDK enforces nothing about `approval`: it is the rule's description of the
gate, and routing, waiting and expiry are the host's — the same relationship
the SDK has with a throttle. A policy default may be `requires_approval` too.

### Shorter answers

Call sites that only branch on the outcome can ask for it directly:

```ts
if (!govplane.evaluate({ target, context }, { asBoolean: true })) return forbidden();

const allowed = govplane.evaluate({ target, context }, { asBinary: true });   // 1 | 0
const effect  = govplane.evaluate({ target, context }, { effectOnly: true }); // 'allow' | 'deny' | …
```

The return type follows the option, so none of these need narrowing.

| Decision | `asBoolean` | `asBinary` |
| --- | --- | --- |
| `allow` | `true` | `1` |
| `custom` | `true` | `1` |
| `deny` | `false` | `0` |
| `kill_switch` | `false` | `0` |
| `requires_approval` | **`false`** | **`0`** |
| `throttle` | **`false`** | **`0`** |

`throttle` reduces to false even though it permits the action. A boolean cannot
carry the limit, so a caller who saw `true` would proceed at an unbounded rate —
failing open on the one effect whose purpose is to bound it. **If you act on
throttles, read the full decision** and use `decision.throttle`.
`requires_approval` is false for the same reason: the action is permitted only
once someone has approved it, and a boolean that said `true` would skip them.

All three are lossy by design: a kill switch's service, a custom effect's value
and a throttle's window are only on the full object. Set at most one — setting
two throws `ConfigurationError`, rather than picking one for you.
`evaluateWithTrace` always returns the full decision, because a trace with
nothing to explain is not worth having.

## Evaluating a single rule

A rule can be addressed by name instead of by target:

```ts
govplane.evaluate({ ruleId: 'deny-after-five-failures', context: { failedAttempts: 6 } });
```

This is for call sites that already know which rule they mean, where restating
the service, resource and action is repetition that can drift from the bundle.
Target matching is skipped entirely — the rule's own target says what it covers,
not whether it was selected — but `context` still matters, because the rule's
condition reads it.

**Both ways of asking give the same answer.** If the rule does not fire, its
owning policy's default applies, exactly as it would had you named the target:

```ts
// deny-after-five-failures fires at >= 5; its policy allows by default
govplane.evaluate({ ruleId: 'deny-after-five-failures', context: { failedAttempts: 3 } });
// → { decision: 'allow', reason: 'default', policyKey: 'login-protection' }
```

**Rule ids are unique within a policy, not across a bundle.** Two policies may
each contain a rule called `deny-large`, and such a bundle is valid. Given only a
`ruleId`, the first match in bundle order wins. Name the policy to remove the
ambiguity:

```ts
govplane.evaluate({ ruleId: 'deny-large', policyKey: 'refund-control', context });
```

If the rule — or the named policy — is not in the bundle, this **throws**
`RuleNotFoundError` rather than returning a denial. Naming something that is not
there is a mistake in the calling code, and reporting it as `deny` would leave a
typo looking like a policy decision nobody investigates.

## Verification

Signature verification is not optional by accident. A bundle decides who may do
what, so the SDK will not evaluate one whose provenance it cannot establish
unless you say so in writing:

```ts
await createLocalClient({ bundlePath: './policy-bundle.json', allowUnsigned: true });
```

| Algorithm | Local bundles | Cloud bundles |
| --------- | ------------- | ------------- |
| `ECDSA_SHA_256` | ✅ | ✅ |
| `HMAC_SHA256` | ✅ | ❌ |

HMAC is refused from Govplane Cloud deliberately. Verifying an HMAC signature
means holding the key that produced it, and a cloud signature is made inside a
FIPS 140-3 Level 3 HSM by a key that never leaves it. A shared secret would
defeat that. For a bundle you signed yourself with the CLI, you own both halves
and HMAC is fine.

**Ed25519 is not supported.** It was accepted by the 1.x isolated-mode verifier,
but nothing has ever produced it and AWS KMS cannot. A bundle carrying an
Ed25519 signature is rejected with a message saying so.

### What a signature does and does not tell you

A verified signature proves the bundle has not changed since it was signed by
the key you configured. It says nothing about *where* it was signed. A bundle
signed by `govplane sign` on a laptop is software-signed; only bundles
materialised by Govplane Cloud are signed in a validated HSM. If that
distinction matters to you, it has to come from your own key management — not
from `signature.algorithm`.

The same honesty applies to [decision records](#decision-records) with
`chain: true`. A hash chain proves that a *stored* sequence of records was not
altered or thinned after the fact. It proves nothing about the process that
wrote it: whoever controls that process can write a valid chain of anything.
Chaining is tamper-evident, not tamper-proof. Non-repudiation needs a signing
key the host does not hold, which is a Govplane Cloud capability.

## Configuration

### Context validation

Off unless you configure a policy:

```ts
await createLocalClient({
  bundlePath: './policy-bundle.json',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey },
  engine: {
    contextPolicy: {
      allowedKeys: ['failedAttempts', 'plan', 'country'],
      blockLikelyPiiKeys: true,
    },
  },
});
```

The engine ships a seven-key sample policy. Enforcing it by default would reject
the very keys your own rules read, so a client enforces a policy only when you
pin one. Pin your real key set and it is enforced — including the PII-name
heuristic, which is worth having.

### Required signals

A policy for an AI system acts on measurements of it — a PII classifier's
score, an injection detector's verdict. Those arrive as ordinary numeric
context keys, and a rule such as `piiScore > 0.8 → deny` reads them like any
other. The problem is what happens when the score is *absent*: a comparison
against a missing key is false, the rule does not match, and the request
proceeds. That is a fail-open path nobody chose.

Declaring the dependency closes it:

```ts
await createLocalClient({
  bundlePath: './policy-bundle.json',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey },
  engine: {
    signals: {
      required: [
        { signal: 'piiScore', when: { service: 'agent' } },   // scoped to a target
        'injectionScore',                                     // every target
      ],
      onMissing: 'deny',   // 'deny' | 'kill_switch' | 'allow' | 'throw'
    },
  },
});

govplane.evaluate({ target, context: { tenant: 'acme' } });
// { decision: 'deny', reason: 'signal_missing', missingSignals: ['piiScore', 'injectionScore'] }
```

A signal is present when it is a finite number. `0` is present; `NaN`,
`Infinity`, `null` and `'0.87'` are not. `when` names any of `service`,
`resource` and `action`, and an omitted field means any. The check runs before
any policy is consulted and applies equally to a rule addressed by name, so
naming the rule is not a way around it. `onMissing` defaults to `deny`;
`'throw'` raises `SignalMissingError` (`SIGNAL_MISSING`). `status().signals`
reports what is declared.

Confidence is just another signal, and a fail-closed threshold on it is just a
rule: `{ "if": { "piiConfidence": { "lt": 0.6 } }, "effect": "deny" }`. See
[`docs/ai-signals.md`](docs/ai-signals.md) for the pattern end to end.

### Decision records

`evaluate()` already returns `policyKey` and `ruleId`. A record ties that to
the bundle that produced it and a timestamp, and hands it to a sink you
provide — so the claim *"this action was blocked by rule `r_pii_export` in
policy `data-handling`, from bundle `sha256:a91f…`, at 14:02:11Z"* is produced
by the SDK rather than assembled by every host differently.

```ts
await createLocalClient({
  bundlePath: './policy-bundle.json',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey },
  record: {
    sink: (records) => logger.info({ records }, 'govplane decisions'),
    include: { context: ['piiScore', 'injectionScore', 'tenant'] },
    batch: { maxRecords: 100, maxDelayMs: 1000 },
    sample: { rate: 0.05, always: ['deny', 'kill_switch', 'requires_approval'] },
    chain: true,
  },
});

await govplane.flushRecords();   // before exit, if losing the tail is unacceptable
govplane.close();                // flushes too, with a bounded wait
```

The sink is called outside `evaluate()`, in batches, and never inline. A sink
that throws or rejects is reported through `onError` with code
`RECORD_SINK_ERROR` and cannot affect the decision that was already returned.
The queue is bounded; past it, `overflow` applies (`drop-oldest` by default)
and every drop is counted in `status().records.dropped` and visible as a gap
in `seq`. Nothing is recorded unless `record` is configured.

**No context value is recorded unless its key is named in `include.context`.**
There is no wildcard and no default set. `contextKeysPresent` always lists the
key *names* supplied, so a record can show that a score was supplied without
recording it. Naming a key the PII heuristic flags, while a context policy
that blocks such keys is in force, is an `INVALID_CONFIGURATION` at
construction.

Record schema, sink patterns and chain verification:
[`docs/decision-records.md`](docs/decision-records.md).

### Watching for changes

**A local bundle is read once, at construction.** Replacing the file on disk
changes nothing until you ask for it — pass `watch` to reload when it changes:

```ts
await createLocalClient({
  bundlePath: './policy-bundle.json',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey },
  watch: { intervalMs: 5000 },
  onError: (error) => logger.warn({ error }, 'policy reload failed'),
});
```

A failed reload never replaces a good bundle with nothing: the previous bundle
stays in force and `onError` is called. The same is true of a remote fetch
failure — after repeated failures the client reports `degraded`, still serving
the last bundle it verified.

### Traces

```ts
const result = govplane.evaluateWithTrace(
  { target, context },
  { level: 'full', force: true },
);
console.log(formatTrace(result.trace, { includeDiscarded: true }));
```

Levels are `off`, `errors`, `sampled` and `full`. Traces carry no context
values — only rule identifiers, priorities and outcomes.

Traces are sampled and budgeted, so they describe decisions rather than count
them. To count, use `onDecision` below.

### Counting decisions

`onDecision` fires on **every** evaluation, unsampled, through both `evaluate()`
and `evaluateWithTrace()`:

```ts
const govplane = await createLocalClient({
  bundlePath: './bundle.json',
  allowUnsigned: true,
  onDecision: (decision) => {
    metrics.increment('policy.decision', {
      policy: decision.policyKey ?? 'none',
      outcome: decision.decision,
    });
  },
});
```

It receives the decision before output shaping, so `policyKey` and `ruleId` are
present even when the call site asked for a bare boolean. It runs on the hot
path — keep it to a counter increment. Anything thrown is swallowed rather than
allowed to fail the evaluation.

Available on any client, local or remote, with no account required.

## Observability

Govplane Cloud subscribers can report decision counts and runtime health
directly from the SDK:

```ts
const govplane = await createRemoteClient({
  ...remoteConfig,
  observe: {
    enabled: true,
    endpoint: 'https://<tenantId>.ingest.govplane.com',
    source: 'checkout-api',

    ingestDecisionTracing: true,      // what your policies decided
    ingestCustomMetrics: true,        // what your application reports
    ingestPerformanceMetrics: false,  // what this process is doing
  },
});
```

Ingestion is metered and billed, so each category is off until you name it.
`ingestPerformanceMetrics` is the costly one — its metrics are per-instance, so
the bill scales with replica count rather than metric count. `enabled: false`
switches everything off without unpicking the rest of the config.

Decisions are aggregated in-process and shipped as counts on a 300-second
interval. Nothing from the evaluation input is sent — only which rule decided,
what it decided, and under which bundle version.

Your own application metrics travel the same path, which is what lets an alert
rule correlate a policy's behaviour with its consequences:

```ts
client.observe?.event('payment.failed', {
  category: 'error_rate',
  tags: { provider: 'stripe' },
});
client.observe?.metric('checkout.queue_depth', depth, { unit: 'count' });
```

It cannot slow down `evaluate()`, cannot throw at your application, cannot grow
without bound, and cannot keep your process alive. If the endpoint is
unreachable or your quota is exhausted, policies keep evaluating and only
telemetry stops.

Off unless configured; the code is not loaded unless it is.

See [docs/observability.md](docs/observability.md) for the full reference.

## Errors

Every error carries a stable `code`:

| Code | Meaning |
| ---- | ------- |
| `BUNDLE_READ_ERROR` / `BUNDLE_PARSE_ERROR` | The file is missing or not JSON |
| `BUNDLE_INVALID` + a specific code | Structural validation failed |
| `CHECKSUM_MISMATCH` | Contents do not match the embedded checksum |
| `BUNDLE_UNSIGNED` | Unsigned, and `allowUnsigned` was not set |
| `BUNDLE_SIGNATURE_MISSING` | A key is configured; the bundle has no signature |
| `BUNDLE_SIGNATURE_UNVERIFIED` | Signed, but no key configured to check it |
| `BUNDLE_SIGNATURE_INVALID` | The signature does not match |
| `BUNDLE_SIGNATURE_ALGORITHM_MISMATCH` | Key algorithm ≠ signature algorithm |
| `BUNDLE_SIGNATURE_ALGORITHM_UNSUPPORTED` | Not acceptable from this source |
| `BUNDLE_SIGNATURE_ALGORITHM_REMOVED` | Ed25519 |
| `BUNDLE_SIGNATURE_CONFIG_ERROR` | Malformed key material |
| `INVALID_CONFIGURATION` | The client cannot be built as configured — including a malformed `record` or `engine.signals` block, or `include.context` naming a likely-PII key |
| `INVALID_EVALUATE_OPTIONS` | More than one of `asBoolean`, `asBinary`, `effectOnly` |
| `RULE_NOT_FOUND` | A rule or policy named in `evaluate` is not in the bundle |
| `SIGNAL_MISSING` | A required signal was absent and `onMissing` is `throw` |
| `RECORD_SINK_ERROR` | The record sink threw or rejected; passed to `onError` |
| `INVALID_APPROVAL_DEFAULT` | A `requires_approval` default whose `approval` is not an object |

Validation codes match `govplane validate`, so a code in your application log
means the same thing as a code in the CLI's output.

## Migrating from 1.x

See [`docs/migration.md`](docs/migration.md). In short:

| 1.x | 2.x |
| --- | --- |
| `new RuntimeClient({ baseUrl, runtimeKey, … })` | `createRemoteClient({ … })` |
| `isolation: { safeBundlePath, publicKey, expectedOrgId, … }` | `createLocalClient({ bundlePath, verify })` |
| Ed25519 safe bundles | ECDSA_SHA_256 or HMAC_SHA256 |
| `orgId` / `projectId` always required | required for remote only |

## Contributing

Contributions are accepted. The source is public so you can read exactly what
runs in your application, and the local half of the SDK — the evaluation engine,
bundle parsing and validation, verification, errors, types, docs and tests — is
open to pull requests on the usual terms.

The exception is the Govplane Cloud client: `createRemoteClient`, the remote
bundle source, authentication and telemetry. That code implements one half of a
contract whose other half is closed and on its own release schedule, so **a pull
request touching it has a high chance of being rejected even when it is
correct**. Open an issue first and let us tell you whether a patch can land.

Bug reports are very welcome either way — see [`CONTRIBUTING.md`](CONTRIBUTING.md)
for what makes a useful one, and [`SECURITY.md`](SECURITY.md) for anything that
should not be a public issue.

## Licence

MIT.
