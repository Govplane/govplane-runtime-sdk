# Contributing

`@govplane/runtime-sdk` is published openly on npm and its source is public so
that you can read exactly what runs in your application — which matters a great
deal for a library that decides who may do what. Contributions are welcome.

Before opening a pull request, please read the notes below — in particular the
section on Govplane Cloud — so nobody's time is wasted.

## Areas open for contribution

Most of the SDK is straightforward to contribute to: the local evaluation
engine, bundle parsing and validation, error handling, type definitions,
documentation, and tests are all reasonable targets for a pull request.

## Contributions touching Govplane Cloud connection, authentication or telemetry

Code that affects how the SDK connects to, authenticates with, or communicates
with Govplane Cloud services is subject to **stricter review**. This includes
anything in or around `createRemoteClient`, token exchange, session management,
and telemetry. Such pull requests:

- must include a clear explanation of the problem being solved and why the
  current behaviour is wrong or insufficient;
- will be reviewed against the control plane's contract before any merge is
  considered;
- **may be rejected** even if the code is correct, if the change conflicts with
  upcoming infrastructure work or internal release constraints.

This is not a comment on the quality of the contribution. It is a consequence
of the release process being tied to the control plane's.

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

## What is open source

The CLI and the toolkit are, and they take contributions:

- [`@govplane/cli`](https://github.com/govplane/govplane-cli)
- [`@govplane/toolkit`](https://github.com/govplane/govplane-toolkit)

Between them they cover authoring, building, signing, simulating and analysing
policy bundles — and none of it requires Govplane infrastructure.
