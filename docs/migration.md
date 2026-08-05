# Migrating from 1.x

The 2.0 SDK changes three things that matter: how you construct a client, which
signature algorithms are accepted, and **which bytes a signature covers**.

The third is the reason for the release. If you were verifying signatures in
1.x, read [Why signatures changed](#why-signatures-changed) before anything
else.

---

## Constructing a client

### Remote

```diff
- const client = new RuntimeClient({
-   baseUrl, runtimeKey, orgId, projectId, env,
-   signing: { algorithm: 'ECDSA_SHA_256', publicKey },
-   pollMs: 5000,
- });
- await client.start();
+ const client = await createRemoteClient({
+   baseUrl, runtimeKey, orgId, projectId, env,
+   verify: { algorithm: 'ECDSA_SHA_256', publicKey },
+   poll: { intervalMs: 5000 },
+ });
```

The first fetch happens during construction, so there is no separate `start()`
and no window where the client exists without a bundle.

### Local — formerly isolated mode

```diff
- const client = new RuntimeClient({
-   baseUrl, runtimeKey,
-   isolation: {
-     safeBundlePath: '/etc/govplane/safe-bundle.json',
-     publicKey,
-     expectedOrgId: 'org_…',
-     expectedProjectId: 'proj_…',
-     expectedEnv: 'prod',
-     triggerFilePath: '/etc/govplane/isolated.mode',
-   },
- });
+ const client = await createLocalClient({
+   bundlePath: '/etc/govplane/policy-bundle.json',
+   verify: { algorithm: 'ECDSA_SHA_256', publicKey },
+ });
```

Note what is gone: `baseUrl`, `runtimeKey`, `expectedOrgId`, `expectedProjectId`
and `expectedEnv`. A local bundle needs none of them.

**Isolated mode is no longer a mode.** It was a fallback you switched into when
the control plane was unreachable. A local bundle is now simply a source you
choose. If you want the old "run from the local copy when the network is gone"
behaviour, construct a local client — that *is* the behaviour, permanently, with
no trigger file to manage.

## Renamed and removed

| 1.x | 2.x |
| --- | --- |
| `RuntimeClient` | `createRemoteClient()` |
| `IsolationModeConfig` | `LocalClientConfig` |
| `SafeBundle` | `RuntimeBundle` |
| `SafeBundleSignature` | `BundleSignature` |
| `SafeBundleValidationError` | `BundleValidationError` (the old name still resolves) |
| `signing:` | `verify:` |
| `pollMs`, `backoffBaseMs`, … | `poll: { intervalMs, backoffBaseMs, … }` |
| `safeBundlePath` | `bundlePath` |
| `triggerFilePath`, `GOVPLANE_MODE=isolated` | removed — use a local client |
| `canonicalJson()` | `canonicalPayload()` — **different bytes**, see below |

`createPolicyEngine`, `formatTrace`, all decision and trace types, and every
`engine` option are unchanged.

## Why signatures changed

In 1.x the SDK verified signatures over bytes **nobody was signing**.

`gp-worker` and the CLI both sign a *projection* of the bundle:

```text
{ schemaVersion, orgId, projectId, env,
  policies[] → { policyKey, activeVersion, defaults, rules } }
```

deep key-sorted, compact UTF-8. `generatedAt`, `bundleVersion`, `checksum` and
`signature` are outside it, which is what lets a bundle be re-versioned without
invalidating its signature.

The 1.x SDK had two verifiers and neither used that projection: one hashed the
whole response body, the other the whole document minus `signature`. Both are
now replaced by a single path over the correct bytes, checked against fixtures
shared with the CLI and `gp-worker`.

**What this means for you:** if signature verification appeared to work in 1.x,
it was doing something other than what you assumed. If it appeared to be broken,
it was. Either way, 2.0 verifies what is actually signed.

### Ed25519 is gone

The 1.x safe-bundle verifier accepted Ed25519 and nothing else. Nothing has ever
produced an Ed25519 bundle signature — `gp-worker` signs safe bundles with
ECDSA_SHA_256 — and AWS KMS does not offer Ed25519 at all, so it can never be
part of a validated signing path.

Re-sign with `govplane sign --signing-algorithm ECDSA_SHA_256`.

### HMAC is local-only

A cloud bundle must now be ECDSA-signed. Verifying HMAC means holding the
signing secret, and a cloud signature comes from a key that never leaves a
FIPS 140-3 Level 3 HSM. HMAC remains fully supported for bundles you sign
yourself with the CLI.

If you are on the basic plan and verifying HMAC-signed cloud bundles today,
you need an ECDSA key before upgrading. That migration is tracked separately.

## Behaviour changes worth knowing

**Unsigned bundles are refused by default.** 1.x isolated mode required a
signature; the remote path verified only when `signing` was configured. 2.0 is
consistent: no verification key means no evaluation, unless you pass
`allowUnsigned: true`. This is deliberate friction on a decision worth making
explicitly.

**A signed bundle with no configured key is also refused.** Silently treating it
as verified would be the most dangerous possible default.

**Context validation is off unless you configure a policy.** 1.x defaulted
`validateContext` to `true` against a seven-key sample allow-list, which rejects
the keys real bundles read. If you were setting `validateContext: false` to work
around this, you can drop it. If you want validation, pass a `contextPolicy`.

**`orgId` and `projectId` are optional for local bundles.** They address a
bundle within the control plane. A bundle built by `govplane build` has no
scope, and requiring one was the last thing tying local evaluation to a
Govplane account.

## Checklist

1. Replace `new RuntimeClient(...)` with `createRemoteClient(...)`, `await` it,
   drop `start()`.
2. Replace `isolation: {...}` with a separate `createLocalClient(...)`.
3. Rename `signing:` to `verify:`.
4. Move poll and backoff options under `poll: {}`.
5. Re-sign Ed25519 bundles with ECDSA_SHA_256.
6. Decide `allowUnsigned` for any bundle you do not verify.
7. Drop `validateContext: false` if you set it only to disable the sample policy.
8. Run your policy tests. If a signature that "worked" in 1.x now fails, the
   bundle was not signed over the bytes 1.x was checking — re-sign it with the
   current CLI.
