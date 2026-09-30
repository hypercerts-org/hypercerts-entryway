# Runtime resilience

Command: `./tests/local.sh resilience`; included last by `fresh`/`all`.

**Prerequisite:** browser and contract runs complete, at least one active
signed-in client exists, all core services healthy, no other test container
running. This command is deliberately disruptive to its selected sandbox only.

1. Capture identity/repository baseline and refresh a real client session.
2. Stop Entryway while managed PDS services remain running.
3. Probe the expected resource/token behavior with existing credentials.
4. Start Entryway and confirm recovery.
5. Stop/restart PostgreSQL, DNS, gateway, PLC, Entryway and both managed PDS
   services while retaining volumes; compare persistent identity/data.

The controller attempts service restoration after failure or interruption and
records restoration errors separately. Private probe credentials are stored in
a temporary directory and removed; only intended result reports are retained.
See `tests/artifacts/.../resilience.json` and per-phase files. A failed probe
stays failed even if restoration succeeds.

Do not run against a user-owned production stack. The controller requires the
scoped `hypercerts-entryway` project prefix and reads its selected Compose file.
