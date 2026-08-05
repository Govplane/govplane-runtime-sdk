# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 2.x     | ✅        |
| 1.x     | ❌ — see below |

**1.x is not supported.** Its bundle verification did not check the bytes that
`gp-worker` and `@govplane/cli` actually sign, so a signature it reported as
valid did not mean what a reader would reasonably assume. If you are verifying
signatures on 1.x, upgrading is a security fix, not a feature release. See
[`docs/migration.md`](docs/migration.md).

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report them privately to **security@govplane.com**, or through GitHub's private
vulnerability reporting on this repository.

Include, where possible:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The SDK version and your Node.js version

**Never include key material** — no HMAC secrets, no private keys. A public key
and a bundle are enough to reproduce a verification problem.

## What we consider a vulnerability

Anything that lets a bundle be evaluated when it should have been rejected:

- A tampered bundle passing verification
- A signature verifying against the wrong key, algorithm or bytes
- A canonicalisation difference that lets two different bundles produce the same
  signature
- Key material appearing in an error message, a log line or a status object
- A remote bundle being accepted with an algorithm reserved for local ones

Also in scope: anything that lets a caller reach the network, the filesystem or
another process through configuration the SDK accepts.

## What we do not

- **Denial of service through a bundle you supplied yourself.** The SDK
  evaluates the bundle you point it at; a pathological one is your own input.
- **`allowUnsigned: true` accepting an unsigned bundle.** That is the documented
  purpose of the flag.
- **Anything in the 1.x line.** Upgrade.

## Response

We aim to acknowledge a report within three working days, and to agree a
disclosure timeline with you. Fixes for verification issues are released as
patch versions across every supported major line.
