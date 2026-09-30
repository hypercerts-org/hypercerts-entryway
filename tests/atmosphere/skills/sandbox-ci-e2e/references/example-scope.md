# Narrow example, broader adaptation

The checked-in
[`examples/ci`](../../../../examples/ci/) managed probe and
[workflow](../../../../.github/workflows/ci-example.yml) are the verified narrow
recipe. They do not establish a general platform support matrix.

Maintain one small smoke test with two modes: a prepared managed container and
the local Linux CI host. Name one tested Linux image, local Docker Engine setup,
Node version, and Chromium/Playwright version. Reuse the same canonical HTTPS
endpoint and test in both modes. Prove normal certificate verification in Node
and browser rather than adding a complete OAuth suite.

Include one hostname created after startup in the same example and the host
resolver configuration that enables it. Static hosts entries alone do not
demonstrate dynamic name resolution. Prepare dependencies and browser binaries
before isolated runtime execution.

Show actual setup/cleanup commands and a small useful report. The native CI
workflow pins both checkouts and exercises unconditional artifacts/cleanup
after both success and intentional test failure. A provider skeleton alone is
not this verified recipe.

Keep the example to this platform/browser combination. The client-connectivity
skill carries it to other requested OS/resolver/browser/profile setups and
validates each adaptation. Remote Docker and Docker Desktop must not inherit
claims from the Linux Engine result. Add another maintained example only for a
materially different workflow that cannot be adapted clearly.

Skills reduce repeated discovery; they do not substitute for missing framework
features, working example acceptance criteria, or actual reachability proof.
