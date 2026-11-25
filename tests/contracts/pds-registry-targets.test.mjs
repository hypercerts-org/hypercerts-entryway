import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPdsRegistryTargets } from "../../dist/src/pds/registry-targets.mjs";

test("target policy accepts only canonical HTTPS origins and explicit IP addresses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "entryway-targets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "targets.json");
  assert.equal(await loadPdsRegistryTargets(undefined), undefined);
  const write = (value) =>
    writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await write({ "https://pds.example": ["192.0.2.1", "2001:db8::1"] });
  assert.deepEqual(
    [...(await loadPdsRegistryTargets(file))],
    [["https://pds.example", ["192.0.2.1", "2001:db8::1"]]],
  );
  for (const value of [
    { "http://pds.example": ["192.0.2.1"] },
    { "https://pds.example/path": ["192.0.2.1"] },
    { "https://pds.example": ["pds.example"] },
    { "https://pds.example": [] },
    { "https://192.0.2.1": ["192.0.2.2"] },
  ]) {
    await write(value);
    await assert.rejects(
      loadPdsRegistryTargets(file),
      (error) => error.message === "InvalidPdsRegistryTargets",
    );
  }
});

test("startup verifier snapshot isolates later address and CA mutations", async () => {
  const { snapshotPdsRegistryVerifier, pdsVerifierPolicy } =
    await import("../../dist/src/pds/registry-targets.mjs");
  const revision = {
    publicUrl: "https://pds.example",
    internalUrl: "https://pds.example",
  };
  const source = {
    targets: new Map([["https://pds.example", ["192.0.2.1"]]]),
    ca: Buffer.from("initial CA"),
  };
  const pinned = snapshotPdsRegistryVerifier(source);
  const fingerprint = pdsVerifierPolicy(revision, pinned);
  source.targets.get("https://pds.example").push("192.0.2.2");
  source.ca.fill(0);
  pinned.ca.fill(0);
  assert.deepEqual(pinned.targets.get("https://pds.example"), ["192.0.2.1"]);
  assert.equal(pdsVerifierPolicy(revision, pinned), fingerprint);
  assert.equal(snapshotPdsRegistryVerifier(pinned), pinned);
});

test("stock qualification rejects a path endpoint before making requests", async () => {
  const { checkPdsOutbound } =
    await import("../../dist/src/pds/registry-check.mjs");
  const result = await checkPdsOutbound(
    {
      publicUrl: "https://pds.example/path",
      internalUrl: "https://pds.example/",
      serviceDid: "did:web:pds.example",
      stagedIncomingMigration: false,
    },
    "https://issuer.example",
    "unused",
    undefined,
  );
  assert.equal(result.reason, "unsupported-stock-endpoint");
  assert.equal(result.adminAttempted, false);
});
