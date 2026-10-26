# Governing AI systems with signals

Governing a non-deterministic system means acting on measurements of it: a
classifier's score, a detector's verdict, a model's confidence. The SDK does
not produce any of these — it consumes scores, and never makes a semantic
judgement of its own. What it adds is the thing that matters most when the
measurement is missing or untrustworthy: a declared, enforced answer instead
of a silent one.

This page shows the pattern end to end. It works with any detector.

## 1. Signals are context keys

A signal is a context key whose value came from a probabilistic process. There
is nothing structural to distinguish it from `plan` or `country`, and the SDK
does not try. Signals stay flat, numeric context keys:

```ts
const decision = govplane.evaluate({
  target: { service: 'agent', resource: 'send_email', action: 'invoke' },
  context: {
    piiScore: await piiDetector.score(draft),          // 0..1
    injectionScore: await injectionDetector.score(prompt),
    tenant: session.tenant,
  },
});
```

## 2. Rules read them like any other number

```json
{
  "id": "r_pii_export",
  "target": { "service": "agent", "resource": "send_email", "action": "invoke" },
  "when": { "op": "gt", "path": "ctx.piiScore", "value": 0.8 },
  "effect": { "type": "deny" }
}
```

## 3. Declare the dependency, so absence is a decision and not an accident

Here is the problem the declaration solves. A comparison against a missing
key is `false`. If the detector times out and `piiScore` is not in the
context, `r_pii_export` does not match, the policy default applies, and the
email is sent. Nobody chose that.

```ts
const govplane = await createLocalClient({
  bundlePath: './policy-bundle.json',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey },
  engine: {
    signals: {
      required: [
        { signal: 'piiScore', when: { service: 'agent' } },
        { signal: 'injectionScore' },
      ],
      onMissing: 'deny',
    },
  },
});
```

Now a missing `piiScore` on any `agent` target short-circuits the evaluation:

```ts
// { decision: 'deny', reason: 'signal_missing', missingSignals: ['piiScore'] }
```

What counts as present: a finite number. `0` is a score. `NaN`, `Infinity`,
`null`, `undefined` and `'0.87'` are the things a broken detector hands over,
and none of them is.

### Choosing `onMissing`

| Mode | Returns | When to use it |
| --- | --- | --- |
| `deny` (default) | `{ decision: 'deny', reason: 'signal_missing', missingSignals }` | A client that declared a dependency and did not get it has no basis to allow anything. Matches the engine's deny-by-default posture. |
| `kill_switch` | `{ decision: 'kill_switch', killSwitch: { service, reason: 'signal_missing' }, … }` | The host already treats `kill_switch` as "stop this service"; a detector outage is that kind of event. |
| `allow` | `{ decision: 'allow', reason: 'signal_missing', missingSignals }` | Fail-open, chosen on purpose and visible in the decision and in records. |
| `throw` | throws `SignalMissingError`, code `SIGNAL_MISSING` | Hosts that treat a missing measurement as an exception rather than an outcome. |

Whatever the mode, `reason` is `signal_missing` and `missingSignals` names
what was absent, so the outcome is distinguishable from a rule or a default
and a [decision record](decision-records.md) shows it.

### Scoping

`when` names any of `service`, `resource` and `action`; an omitted field means
any. A PII score matters for an email-sending tool and is irrelevant to a
read-only lookup — scope the requirement, and the lookup is not gated on a
detector it never needed.

The check applies equally to a rule addressed by name (`{ ruleId }`), using
the rule's own target. Naming the rule is not a way around the requirement.

## 4. Confidence is just another signal

Some detectors report a confidence alongside the score. There is no separate
channel for it: a confidence is a number the detector produced, so it is a
signal, and a fail-closed threshold on it is a rule like any other:

```json
{ "when": { "op": "lt", "path": "ctx.piiConfidence", "value": 0.6 }, "effect": { "type": "deny" } }
```

Declare `piiConfidence` as required too, and a detector that reports a score
without a confidence is handled the same way as one that reports nothing.

The SDK does not model confidence natively. This is documented as a pattern
rather than shipped as a feature because it needs no code, and because it
keeps the judgement where it belongs: in the policy, reviewable and signed.

## 5. Human in the loop

Some actions should not be decided by a score at all. `requires_approval` is a
first-class effect for exactly this:

```json
{
  "id": "r_bulk_export",
  "target": { "service": "agent", "resource": "customer_data", "action": "export" },
  "when": { "op": "gt", "path": "ctx.rowCount", "value": 10000 },
  "effect": {
    "type": "requires_approval",
    "approval": { "reason": "bulk export", "approvers": ["security"], "expiresInSeconds": 900 }
  }
}
```

```ts
const decision = govplane.evaluate({ target, context });
if (decision.decision === 'requires_approval') {
  await approvals.request(decision.approval, { target, context });
  return pending();
}
```

It sits just below `deny` in precedence: an outright refusal still wins, but a
gate outranks any rule that would have let the action proceed, throttled or
not. Under `asBoolean` it is `false` — permitted only once someone has acted.
The `approval` descriptor is the rule's description of the gate; routing,
waiting and expiry are the host's, exactly as a throttle's limit is.

## 6. Record what happened

Signals, gates and outcomes are only useful in an audit if they were written
down by something other than the host's own logging. With `record` configured,
every evaluation above produces a record that names the rule, the bundle
checksum, which signals were supplied, and — only for the keys you name —
their values:

```ts
record: {
  sink: (records) => audit.write(records),
  include: { context: ['piiScore', 'injectionScore', 'piiConfidence'] },
  sample: { rate: 0.05, always: ['deny', 'kill_switch', 'requires_approval'] },
}
```

A `signal_missing` decision is recorded with its `missingSignals`, so a
detector outage is visible in the audit trail as what it was.

See [`decision-records.md`](decision-records.md).

## Putting it together

```ts
import { createLocalClient } from '@govplane/runtime-sdk';

const govplane = await createLocalClient({
  bundlePath: './policy-bundle.json',
  verify: { algorithm: 'ECDSA_SHA_256', publicKey },
  engine: {
    contextPolicy: {
      allowedKeys: ['piiScore', 'piiConfidence', 'injectionScore', 'rowCount', 'tenant'],
      blockLikelyPiiKeys: true,
    },
    signals: {
      required: [
        { signal: 'piiScore', when: { service: 'agent' } },
        { signal: 'piiConfidence', when: { service: 'agent' } },
        'injectionScore',
      ],
      onMissing: 'deny',
    },
  },
  record: {
    sink: (records) => audit.write(records),
    include: { context: ['piiScore', 'piiConfidence', 'injectionScore'] },
    chain: true,
  },
  onError: (error) => logger.warn({ error }, 'govplane'),
});
```

With this, a detector that fails closed does so by policy, a gated action
waits for a person, and every decision is on record with the bundle that made
it.
