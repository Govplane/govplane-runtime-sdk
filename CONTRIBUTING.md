# Contributing

`@govplane/runtime-sdk` is published openly on npm and its source is public so
that you can read exactly what runs in your application — which matters a great
deal for a library that decides who may do what. Contributions are welcome.

Before opening a pull request, please read the notes below — in particular the
section on Govplane Cloud — so nobody's time is wasted.

## Areas open for contribution

Most of the SDK is straightforward to contribute to: the local evaluation
engine, bundle parsing and validation, signature verification, error handling,
type definitions, documentation, and tests are all reasonable targets for a
pull request.

The one area to approach differently is the Govplane Cloud client, immediately
below.

## Contributions touching Govplane Cloud connection, authentication or telemetry

**A pull request that changes this area has a high chance of being rejected.**
Please read this section before writing the code, not after.

It covers anything affecting how the SDK connects to, authenticates with, or
communicates with Govplane Cloud — in particular `createRemoteClient`, the
remote bundle source, token exchange, session management and telemetry.

The reason is not the quality of the contribution. This code implements one half
of a contract whose other half is the control plane, which is closed and on its
own release schedule. A change that is correct against today's contract can
still conflict with infrastructure work already in progress, and we cannot
always say publicly why.

So a pull request here:

- **is likely to be rejected**, even when the code is correct and the problem
  is real;
- will be reviewed against the control plane's contract before any merge is
  considered;
- must explain the problem being solved and why the current behaviour is wrong
  or insufficient, not only what the patch does.

**Open an issue first.** Describe the problem and let us tell you whether a
patch can land before you spend the effort. If it cannot, the issue is still
useful — it is how the fix gets scheduled on our side.

## What is very welcome

**Bug reports.** Open an issue. If the SDK accepts a bundle it should reject,
rejects one it should accept, or returns a decision you did not expect, we want
to know, and those reports are read carefully.

The most useful report includes:

- what you configured — `createLocalClient` or `createRemoteClient`, and which
  `verify` algorithm, with **no key material**
- the bundle, or the smallest bundle that reproduces it
- the target and context you evaluated
- what you expected, and what you got, including any error `code`
- SDK version and Node.js version

**Questions about behaviour.** If the documentation is unclear or wrong, an
issue saying so is a genuine contribution — it just is not a patch.

**Security issues.** Do not open a public issue. See
[`SECURITY.md`](SECURITY.md).

## If you want to change how policies are evaluated

The evaluation engine is deliberately identical across the SDK, the CLI's
`govplane simulate`, and the control plane. A change to decision semantics is a
change to the policy language, and it starts as a specification discussion
rather than a patch here. Open an issue describing the behaviour you want and
why the current behaviour is wrong.

## The rest of the toolchain

Also MIT, also open to contributions, and with no closed counterpart to work
around:

- [`@govplane/cli`](https://github.com/Govplane/govplane-cli)
- [`@govplane/cli-toolkit`](https://github.com/Govplane/govplane-cli-toolkit)

Between them they cover authoring, building, signing, simulating and analysing
policy bundles — and none of it requires Govplane infrastructure.
