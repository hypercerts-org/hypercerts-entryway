# Adapt the client connection

The maintained [CI example](../../../../examples/ci/) proves one small flow
on one named Linux/Docker/browser combination. Adapt it to the user's environment and verify
the result; do not infer a support matrix from that example.

## Establish context and capability

Identify where tests run, which machine owns Docker, the OS, runtime/browser
versions, and the selected sandbox. Honor the user's chosen execution mode.
Read public connection JSON only if the pinned CLI supports it; otherwise use
`access`, manifest fields, and targeted resource inspection. Never print whole
private state or expanded service environments.

| Client location | Path | What to establish |
| --- | --- | --- |
| Managed container | Sandbox DNS and HTTPS gateway | Prepared image, CA readiness, runtime and browser trust |
| Independent container project | Existing project network/public CA | Shared-network skill, actual physical names and DNS |
| Local host | Fixed loopback HTTPS relay | Name resolution, public trust, available port 443 |
| Remote Docker or unsupported host | No assumed host path | Offer container execution or identify the concrete access gap |

## Dynamic names

A hosts file cannot resolve a previously unseen account name. Host tests using
the loopback relay need a CI-managed resolver rule mapping declared route names
and suffixes to loopback. Scope it to the sandbox and preserve unrelated host
resolution. Sandbox CoreDNS returns the container HTTPS gateway address;
forwarding host queries there alone does not establish the loopback relay path.

If host clients resolve lexicons, provide their private TXT owners too. Mapping
only an application suffix does not cover `_lexicon` owners on other domains.
Inspect the resolver actually used by the browser/runtime, including secure DNS
where relevant. Consult official OS/resolver documentation for actual commands.
The container sandbox retains its closed DNS behavior.

Create a name after startup and resolve/request it from the test context without
adding an individual hosts entry. When validating wildcard support, check the
one-label rule, apex and deeper names across DNS and HTTPS. If the pinned AiaB
lacks wildcard declarations, report or implement the scoped capability gap;
skill guidance does not make the proposed feature available.

## Trust and prepared dependencies

Install packages, browsers, trust utilities, and package-manager shims on the
host or during image build before runtime isolation. Check that the runtime
user has a writable profile and artifact directory.

Wait for CA export and inspect only the public root/fingerprint. Containers
mount `public-ca:/ca:ro`; configure Node/Deno CA trust before launching clients.
Browser trust is separate. Use the actual browser build's supported store or
temporary profile, consulting current official documentation rather than
assuming all Chromium builds use the same certificate store. Never copy private
CA keys or a developer's browser profile into the test environment.

## Diagnose and verify

1. Resolve a canonical name from the actual client context; its destination
   must match the chosen path (loopback for relay, gateway inside the sandbox).
2. Check TCP access and relay ownership/status without changing other jobs.
3. Verify TLS chain and hostname against the public root, using the canonical
   URL so normal hostname/SNI handling remains intact.
4. Run the Node/Deno probe and browser request, then the consumer test.

Distinguish DNS failure, connection refusal, certificate failure, and application
or OAuth rejection. Apply the relevant correction, retaining the original
failure; do not disable TLS checks or add certificates to fix an unreachable IP.

Record platform, Docker mode, runtime/browser versions, configured versus
observed addresses, trust scope, dynamic-name results, and commands/results.
Mark untested platforms explicitly. Cleanup restores only task-owned resolver
and trust changes and stops only the selected relay. The CI skill covers
unconditional artifacts and project teardown.
