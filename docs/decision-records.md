# Decision records

A decision record is the SDK's own account of one evaluation: what was asked,
what was answered, and which bundle answered it. The host provides a sink; the
SDK delivers records to it in batches, off the evaluation path. Nothing is
recorded unless `record` is configured.

```ts
import { createLocalClient } from '@govplane/runtime-sdk';

const govplane = await createLocalClient({
  bundlePath: './policy-bundle.json',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey },
  record: {
    sink: (records) => logger.info({ records }, 'govplane decisions'),
    include: { context: ['piiScore', 'injectionScore', 'tenant'] },
    batch: { maxRecords: 100, maxDelayMs: 1000 },
    overflow: 'drop-oldest',
    chain: true,
  },
});
```

The same option works identically on `createRemoteClient`.

## Record schema

```json
{
  "v": 1,
  "id": "01JGX2W4K8N7QZ3M5Y6P8R9T0A",
  "at": "2026-09-14T14:02:11.417Z",
  "seq": 4211,
  "bundle": {
    "version": 7,
    "generatedAt": "2026-09-12T09:31:00.000Z",
    "checksum": "sha256:a91f…",
    "signature": { "algorithm": "ECDSA_SHA_256", "verified": true },
    "origin": "local"
  },
  "target": { "service": "agent", "resource": "send_email", "action": "invoke" },
  "decision": "deny",
  "reason": "rule",
  "policyKey": "data-handling",
  "ruleId": "r_pii_export",
  "contextKeysPresent": ["piiScore", "injectionScore", "tenant"],
  "context": { "piiScore": 0.87, "tenant": "acme" },
  "prev": "sha256:71c0…",
  "hash": "sha256:e4b2…"
}
```

| Field | Notes |
| --- | --- |
| `v` | Schema version, `1`. Pinned by a golden fixture in the test suite. |
| `id` | ULID, generated with `node:crypto`. Sorts by creation order, including within one millisecond. Correlating a record to an application request is the host's job, via the sink. |
| `at` | ISO 8601, when the decision was made. |
| `seq` | Per-client counter, assigned after sampling. A gap always means a dropped record. |
| `bundle.version` | The bundle's `bundleVersion` revision counter; absent when the bundle carries none. |
| `bundle.generatedAt` | The bundle's `generatedAt`, when present. |
| `bundle.checksum` | The embedded checksum, or one computed from the canonical payload when the bundle has none. A record without the checksum of the bundle that produced it is an assertion, not evidence. |
| `bundle.signature.verified` | `false` only when the client was built with `allowUnsigned`. An auditor needs to see that. |
| `bundle.origin` | `local` or `remote`. |
| `target` | The target evaluated, in full. Targets are structural identifiers, not user data; personal data in a target is a modelling error. |
| `ruleAddressed` | Present instead of `target` when a rule was addressed by name: `{ ruleId, policyKey? }`. The record never invents a target. |
| `decision`, `reason`, `policyKey`, `ruleId` | As on the decision. |
| `killSwitch`, `throttle`, `approval`, `value` | The effect's payload, when the decision carried one. Policy data, not input data. |
| `missingSignals` | Present when `reason` is `signal_missing`. |
| `context` | Values for the keys named in `include.context` that were supplied. Absent when none were. |
| `contextKeysPresent` | Every context key supplied — names only, always. |
| `prev`, `hash` | Present only with `chain: true`. `prev` is `null` on the first record. |

Absent fields are omitted, not written as `null`.

## The sink

```ts
type DecisionRecordSink = (records: DecisionRecord[]) => void | Promise<void>;
```

- Called on a microtask or a timer, never inside `evaluate()`.
- A throw or rejection is caught and passed to the client's `onError` as a
  `GovplaneError` with code `RECORD_SINK_ERROR`, `details.records` saying how
  many were lost. It never reaches the caller of `evaluate()` and never affects
  the decision that was already returned.
- A batch is delivered when `batch.maxRecords` are waiting, or `batch.maxDelayMs`
  after the first record of a batch arrived, whichever comes first.
- Records queue up to `maxQueue` (default `batch.maxRecords × 4`) while the
  sink is busy. Beyond that, `overflow` applies: `drop-oldest` (default),
  `drop-newest`, or `block-never`, which is `drop-oldest` under a name that
  says out loud what none of the modes do. Every drop increments
  `status().records.dropped`.

`status().records`:

```ts
{ enabled: true, queued: 12, emitted: 4211, dropped: 0, lastError: null }
```

`lastError` is `{ code, message, at }` for the most recent sink failure.

### Sink patterns

**pino / winston / any structured logger** — one line per batch keeps the
log rate bounded by the batch settings rather than by decision rate:

```ts
record: { sink: (records) => log.info({ records }, 'govplane.decisions') }
```

**One line per record**, for log pipelines that index fields:

```ts
record: { sink: (records) => { for (const r of records) log.info(r); } }
```

**Append to a file**, NDJSON, letting the promise carry back-pressure:

```ts
import { appendFile } from 'node:fs/promises';

record: {
  sink: (records) => appendFile(
    'decisions.ndjson',
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  ),
}
```

**OpenTelemetry logs**:

```ts
record: {
  sink: (records) => {
    for (const r of records) {
      otelLogger.emit({ body: 'govplane.decision', attributes: flatten(r) });
    }
  },
}
```

Whatever the sink does, it should return quickly or return a promise. A sink
that blocks the event loop blocks the application, not just the recorder.

## Sampling

```ts
record: { sink, sample: { rate: 0.05, always: ['deny', 'kill_switch', 'requires_approval'] } }
```

An agent making thousands of decisions per task makes full recording
expensive. `always` names the outcomes recorded regardless of `rate`, and
defaults to `['deny', 'kill_switch', 'requires_approval']` — the ones that
matter. `seq` is assigned after sampling, so a gap in the sequence is a drop,
never an unsampled decision.

## Shutting down

```ts
await govplane.flushRecords();   // delivers everything queued; resolves when the sink has it
govplane.close();                // stops watching, flushes with a two-second bound
```

`close()` is synchronous and never blocks shutdown on a slow sink. If losing
the tail of the stream is unacceptable, `await flushRecords()` first.

## Chaining

With `chain: true`, each record carries the SHA-256 of the previous record's
canonical serialisation. Canonical form is the bundle's: keys sorted at every
depth, no whitespace, UTF-8, with `hash` itself excluded. The first record has
`prev: null`.

Hashing happens on the delivery path, not inside `evaluate()`, and the chain
links the records that reach the sink. A dropped record therefore leaves the
links intact and a gap in `seq` — a verifier can tell a counted drop from
tampering.

### What chaining proves, and what it does not

A verifier walking the sequence can detect that a stored record was removed or
altered after the fact. That is the whole claim. **Chaining is tamper-evident,
not tamper-proof.** Whoever controls the process can produce a valid chain of
whatever they like; it defends against later modification of stored records,
not against a compromised host. Genuine non-repudiation needs a signing key the
host does not hold, which is a Govplane Cloud capability.

### Verifying a chain

```ts
import { verifyRecordChain } from '@govplane/runtime-sdk';

const records = readNdjson('decisions.ndjson');   // in the order the sink received them
const result = verifyRecordChain(records);

// { ok: true, records: 4211 }
// { ok: false, index: 1187, seq: 1188, problem: 'hash_mismatch' }   a record was altered
// { ok: false, index: 1187, seq: 1189, problem: 'broken_link' }     a record was removed
// { ok: false, index: 1187, seq: 1190, problem: 'gap' }             records were dropped, links intact
// { ok: false, index: 0,    seq: 1,    problem: 'missing_chain' }   chain was off
```

Records from different clients are different chains: verify each stream on
its own. `hashRecord(record)` is exported for tools that want to recompute a
single hash.

## Privacy

Traces carry no context values, and that remains an invariant. Records exist
precisely to carry some — an audit record with no inputs explains nothing — so
recording of values is explicit, narrow, and never inferred:

1. **No context value is recorded unless `include.context` names the key.**
   There is no `'all'`, no wildcard, no default set. If every key is wanted,
   every key must be listed; that friction is intentional.
2. **`contextKeysPresent` is always names only.** It answers "was a PII score
   supplied at all" without recording the value.
3. **`include.context` is checked against the PII-key heuristic** whenever a
   context policy is in force and has not turned the heuristic off. Naming a
   key it flags is an `INVALID_CONFIGURATION` at construction, with the key in
   `details`. A client that would record personal data into an audit log fails
   loudly on line one.
4. **Targets are recorded in full.** They are structural identifiers. Personal
   data in a target is a modelling error.
5. **Nothing is recorded by default.** No `record`, no queue, no timer, no
   counters.

## Performance

Building a record is object construction plus a cached timestamp, after the
decision is computed. Hashing for `chain` runs when a batch is delivered, not
when a decision is made. `bench/records.bench.mjs` measures the overhead in
three configurations and runs in CI; `npm run bench` runs it locally. The
budget is p99 overhead under 5% with records and under 10% with chaining, at
10k evaluations per second.
