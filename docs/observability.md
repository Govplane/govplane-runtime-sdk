# Observability

> Available from 2.2.0. Requires a Govplane Cloud subscription and a remote
> client. Optional, off by default, and inert until configured.

The SDK can report what your policies are actually deciding — how often each
rule fires, what it decides, and under which bundle version — so that a policy
change that starts denying traffic it never denied before is something you find
out about rather than something your customers report.

```ts
import { createRemoteClient } from '@govplane/runtime-sdk';

const govplane = await createRemoteClient({
  baseUrl: process.env.GOVPLANE_BUNDLE_URL,
  runtimeKey: process.env.GOVPLANE_RUNTIME_KEY,
  orgId: 'org_...',
  projectId: 'proj_...',
  env: 'prod',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },

  observe: {
    enabled: true,
    endpoint: 'https://<tenantId>.ingest.govplane.com',
    source: 'checkout-api',

    ingestDecisionTracing: true,
  },
});
```

Evaluation is unchanged, and every existing call site keeps working exactly as
it did.

---

## Choosing what to send

Ingestion is metered and billed, so nothing is sent until you name it. `enabled`
is required — configuring an ingest endpoint is not the same as consenting to be
billed for what goes to it — and each category below it is off until you turn it
on.

| Switch | Sends | Cost shape |
|---|---|---|
| `ingestDecisionTracing` | What your policies decided, aggregated in-process | Scales with your **policy estate**, not your traffic. One evaluation costs a counter increment |
| `ingestCustomMetrics` | What your application reports: `event`, `metric`, `record` | Scales with **how many distinct names and tags** you use |
| `ingestPerformanceMetrics` | Memory, CPU, event-loop lag, bundle age | Scales with **replica count**. See the warning below |

```ts
observe: {
  enabled: true,
  endpoint: 'https://<tenantId>.ingest.govplane.com',

  ingestDecisionTracing: true,
  ingestCustomMetrics: true,
  ingestPerformanceMetrics: false,
}
```

**`ingestPerformanceMetrics` is the expensive one, by a wide margin.** These
metrics are per-instance by nature — each process has its own memory — so the
cost scales with how many replicas you run rather than with how many metrics you
collect. Eight metrics across a hundred instances at sixty-second sampling is
roughly ninety times a default project's sustained storage budget. Turn it on
deliberately, start with a longer interval, and watch your quota gauge for a day
before rolling it out fleet-wide.

It also takes an object when the default sixty-second sampling is not what you
want:

```ts
ingestPerformanceMetrics: { intervalSeconds: 300 },
```

### Turning it off

`enabled: false` sends nothing, whatever else is set, and returns before the
module is even loaded — no chunk fetched, no timer, no allocation. Leave the
rest of the block in place and flip the one boolean back when you want it again.

### If you enable ingestion and no category

Nothing is sent, and `onError` is told once at construction. That state is
almost always a mistake, and it is the kind that looks fine until somebody opens
an empty dashboard a week later.

### Calling a stream you did not enable

`client.observe.event()` with `ingestCustomMetrics` off records nothing, raises
one message through `onError`, and returns. It never throws — telemetry
configuration is not allowed to be the reason a request handler fails — and it
warns once per method rather than once per call, because `event` is designed to
be called at request rate.

---

## What it will not do

These are guarantees, not intentions. Each has a test.

| | |
|---|---|
| **It will not slow down `evaluate()`** | Recording a decision is one map increment. Nothing is serialised, queued to disk, or awaited on the decision path. |
| **It will not throw at your application** | No error from this module can reach `evaluate()`. Failures go to `observe.onError` and nowhere else. |
| **It will not grow without bound** | Series are capped. Past the ceiling, counters fold into an `__overflow__` bucket rather than accumulating. |
| **It will not keep your process alive** | Every timer is unreferenced. A CLI or a job exits exactly as promptly as it did before. |
| **It will not become a dependency of evaluation** | If Govplane Cloud is unreachable, or your quota is exhausted, policies keep evaluating. Telemetry is the only thing that stops. |
| **It will not send your request data** | See [What is sent](#what-is-sent). |

---

## What is sent

Decisions are aggregated **in your process** and shipped as counts, not as
individual records. One evaluation costs a counter increment; one interval costs
a handful of data points regardless of how much traffic you serve.

Each counter is keyed by:

| Field | Example |
|---|---|
| `policyKey` | `login-protection` |
| `ruleId` | `deny-after-five` |
| `decision` | `allow`, `deny`, `kill_switch`, `throttle`, `custom` |
| `reason` | `rule` or `default` |
| `bundleVersion` | `41` |

**Nothing from the evaluation input is included.** Not the context, not the
target, not a user id, not an IP address. The identifiers above describe *which
rule decided*, never *who it decided about*.

This is an invariant rather than a default: there is no configuration that adds
request context to what leaves your process, because the point of aggregating
locally is that the raw material never travels.

### Why `bundleVersion` is on every counter

It turns "did the change I published this morning make things worse?" into a
comparison between two versions rather than a comparison between two time
ranges. Instances pick up a new bundle gradually, so a purely time-based
before/after compares a mixture against a mixture. Comparing by version is exact
even mid-rollout.

---

## Custom metrics

Decision telemetry says what your policies decided. Custom metrics say whether
they were right — and they are what an automated rule can actually be trusted
with. "Rule X denied 12% of checkouts" is a curiosity on its own; "…and payment
failures tripled" is a reason to act.

```ts
client.observe?.event('payment.failed', {
  category: 'error_rate',
  tags: { provider: 'stripe', code: 'card_declined' },
});

client.observe?.metric('checkout.queue_depth', depth, { unit: 'count' });
```

Two shapes, because counting a thing and measuring a thing aggregate
differently:

| | | |
|---|---|---|
| `event(name, opts?)` | how many times it happened | summed over the interval |
| `metric(name, value, opts?)` | what the level was | reduced over the interval |

Both aggregate in-process on the same interval as decision counters, and ship in
the same request. Calling `event()` on every request costs a map increment, not
a network call.

`metric` reduces with `last` by default; pass `aggregation` for `avg`, `min`,
`max` or `sum`. The SDK reduces *within* an interval and gp-data's alert rules
reduce *across* intervals, so a rule asking for "max over 5 minutes" still works
on a series recorded with `avg`.

### Categories

`category` scopes which alert rules can match the series, so it is worth the
keystroke:

`custom` (default) · `error_rate` · `http_error_rate` · `request_latency` ·
`resource_consumption` · `security` · `cost`

A payment failure count under `error_rate` can be matched by a rule written for
error rates generally; under `custom` it cannot.

### Tags are dimensions, not detail

Tags are for grouping — provider, region, tier, error code. They are **not** a
place for request detail, and the limits are enforced client-side:

| | |
|---|---|
| Tags per metric | 10 |
| Tag value length | 200 characters |
| Distinct custom series | 500 |

A user id, an email or a request id as a tag value is both a privacy problem and
a cardinality bomb — 500 series is reached quickly when one dimension is
unbounded, and past that new series are **refused** rather than folded, because
an unbounded name set is a bug in the calling code and folding would hide it.

**Why the limits are enforced here rather than by the server.** gp-data
validates a batch all-or-nothing: one point with too many tags rejects every
other point in the same request, including the decision counters that had
nothing to do with it. So an invalid custom metric is dropped locally, reported
through `onError`, and the rest of the interval still ships.

Nothing is retried on your behalf and nothing is silently truncated — you get an
error explaining what was dropped and why.

## Correlating an outcome with the decision that caused it

Aggregated metrics cannot answer "which decision caused *this* one?" — a trace
id is by definition high-cardinality and cannot be a tag on a summed series. For
that, `record()` keeps whole entries:

```ts
const { decision, trace } = client.evaluateWithTrace(input, { level: 'full' });

if (paymentFailed) {
  client.observe?.record('payment declined at capture', {
    traceId: trace?.traceId,
    level: 'error',
    code: 'card_declined',
    metadata: { provider: 'stripe' },
  });
}
```

The `traceId` is what joins the outcome back to the exact evaluation, so the
denial and its consequence can be read together rather than inferred from
timestamps.

### It does not aggregate, and that is the whole point

Five calls are five stored entries. `event()` costs a map increment; `record()`
costs storage. So:

| | |
|---|---|
| Records per interval | **200**, then dropped and reported |
| Message length | 1,000 characters, truncated |
| Metadata | 8 KB, dropped past it |

**This is not a logging facility.** Keep using your own logger for logs. Use
`record()` for the small number of outcomes you need to drill into — a failed
payment, a rejected onboarding — not for anything at request rate. The cap
exists so a `record()` left in a hot path is a dropped-telemetry warning rather
than an exhausted quota.

`metadata` is the one field on this path that carries free-form application
data, and all of it leaves your process. Put the few fields you need to
understand the outcome in it, not a request dump.

Records travel to the log endpoint in their own request, sent **before** the
metric batch: if the metrics are what exhaust the quota, the records explaining
why have already landed.

## Rollup interval

Counters are flushed every **300 seconds** by default, on wall-clock-aligned
boundaries so that buckets from separate replicas line up and sum correctly.

```ts
observe: { endpoint: '…', rollupSeconds: 60 }
```

300 is not a performance default, it is a storage one: a finer interval
multiplies stored data points by the same factor, and observability storage is
metered per project. Start at the default and shorten it if you need the
resolution.

The minimum is 10 seconds.

---

## Health monitoring

```ts
observe: { endpoint: '…', enabled: true, ingestPerformanceMetrics: true }
```

Off by default. It samples every 60 seconds and reports:

| Metric | |
|---|---|
| `gp.runtime.memory.rss_bytes` | Resident memory |
| `gp.runtime.memory.limit_ratio` | Resident memory over the **container** limit, where one is set |
| `gp.runtime.memory.heap_used_ratio` | Heap use over the V8 heap ceiling |
| `gp.runtime.cpu.percent` | CPU, as a share of available cores |
| `gp.runtime.saturation.lag_ms` | Event-loop delay, p99 |
| `gp.runtime.uptime_seconds` | Process uptime |
| `gp.runtime.bundle.age_seconds` | How long the bundle in force has been loaded |

The last one is the one no APM can give you: *which policy version is this
instance actually enforcing, and how stale is it?*

These metric names are a contract shared across every Govplane SDK. An alert
rule written against `gp.runtime.memory.limit_ratio` behaves the same whether
the service is Node, Python or Java.

**Why it is opt-in.** Health metrics are inherently per-instance, so their
storage cost scales with your replica count — a fleet of a hundred is a hundred
times the data of one. That should be a decision you make, not one you discover.


`limit_ratio` is omitted rather than guessed when no container limit can be
read. A missing series is obvious; a ratio computed against the host's memory
instead of the container's would look plausible and be wrong.

---

## Instance identity

Health metrics are tagged with an instance id, resolved from
`GOVPLANE_INSTANCE_ID`, then `HOSTNAME` (the pod name, under Kubernetes), then
the system hostname.

Decision counters are **not** tagged with it by default. Adding it multiplies
your stored series by the size of your fleet, and a fleet total is usually the
question. Turn it on when the question is "is one replica behaving differently
from its peers?":

```ts
observe: { endpoint: '…', perInstance: true }
```

---

## Handling failure

```ts
observe: {
  endpoint: '…',
  onError: (error) => logger.warn({ err: error }, 'govplane telemetry'),
}
```

`onError` is the only place telemetry failures surface. Notable cases:

- **Quota exhausted.** The transport stops for 15 minutes and reports once,
  rather than retrying into a full quota on every interval. The message says
  explicitly that policy evaluation is unaffected, because that is the first
  thing you want to know at 03:00.
- **Endpoint unreachable.** Retried with jittered backoff, then dropped. The
  buffered interval is lost; nothing else is.
- **Runtime key rejected.** Not retried — a 401 will be a 401 again, and
  repeating it is a retry storm against a revoked key.

---

## Shutting down

```ts
await govplane.observe?.flush();  // ship the current bucket now
govplane.close();                 // stops timers, best-effort final flush
```

`close()` does not block on a slow endpoint. If shipping the last bucket matters
to you, `await flush()` first.

---

## Using the module directly

The pieces are exported from a subpath for callers who want to drive them
themselves — a custom transport, a different sink, or tests:

```ts
import { createDecisionAggregator, HEALTH_METRICS } from '@govplane/runtime-sdk/observe';
```

Importing the subpath is the only way to load this code. An application that
never imports it does not carry it.

---

## Sending decisions somewhere that is not Govplane

`onDecision` is a plain hook on any client, local or remote, with no Cloud
subscription involved:

```ts
const govplane = await createLocalClient({
  bundlePath: './bundle.json',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY },
  onDecision: (decision) => {
    metrics.increment('policy.decision', {
      policy: decision.policyKey ?? 'none',
      outcome: decision.decision,
    });
  },
});
```

It fires on every evaluation, unsampled, through both `evaluate()` and
`evaluateWithTrace()`, and receives the decision before any output shaping — so
`policyKey` and `ruleId` are present even when the call site asked for a bare
boolean.

This is the counting companion to
[`trace.onDecisionTrace`](../README.md#traces), and the two answer different
questions. A trace carries full detail and is therefore sampled and budgeted:
`evaluate()` emits none at all, and `evaluateWithTrace()` emits 1% by default.
It can describe a decision; it cannot count one. `onDecision` is the reverse —
cheap, complete, and carrying only identifiers.

Govplane's own observability module is one consumer of this hook. Nothing stops
you pointing it at Prometheus, StatsD or a log line instead.
