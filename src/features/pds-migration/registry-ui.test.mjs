import test from "node:test";
import assert from "node:assert/strict";
import { renderMigrationPanel } from "../../../dist/src/features/pds-migration/page.mjs";
import { createMigrationProof } from "../../../dist/src/features/pds-migration/proof.mjs";
import { createSignupForm } from "../../../dist/src/features/account-registration/page.mjs";

test("registry forms require an eligible choice and retain saved destination", async () => {
  const config = { pds: [], handleDomains: ["test"] };
  let hosts = [{ id: "other", url: "https://other.test" }];
  const accounts = {
    placement: { choices: async () => hosts },
    get: async () => null,
  };
  const db = { list: async () => [] };
  const form = createSignupForm({ db, config, accounts, fields: () => "" });
  let html = await form({}, {});
  assert.match(html, /Choose a data server/);
  assert.match(html, /https:\/\/other.test/);
  hosts = [];
  html = await form({}, {});
  assert.match(html, /No data server is currently available/);
  assert.match(html, /<button disabled>/);
  const panel = renderMigrationPanel({
    config,
    a: { pdsId: "source" },
    csrf: "x",
    accountContext: { did: "did:plc:test" },
    migration: {},
    registry: true,
    destinations: [],
    migrationState: {
      targetPdsId: "retained",
      phase: "pending",
      updatedAt: new Date(),
    },
  });
  assert.match(panel, /retained/);
  assert.match(panel, /Resume data server migration/);
});

test("migration proof only issues for registry candidates", async () => {
  let issued = 0;
  const proof = createMigrationProof({
    config: { pds: [{ id: "static" }] },
    accounts: { placement: { choices: async () => [{ id: "target" }] } },
    proofs: {
      principal: async () => ({ pdsId: "source", email: "x" }),
      issue: async () => {
        issued++;
      },
      consume: async () => {},
    },
  });
  await assert.rejects(proof.requestMigrationProof({}, { pdsId: "static" }));
  await assert.rejects(proof.requestMigrationProof({}, { pdsId: "source" }));
  assert.equal(issued, 0);
  await proof.requestMigrationProof({}, { pdsId: "target" });
  assert.equal(issued, 1);
});

test("saved move continues after its target leaves the eligible list", async () => {
  const { createMigrationActions } =
    await import("../../../dist/src/features/pds-migration/actions.mjs");
  const saved = { targetPdsId: "drained", phase: "pending" };
  let dispatched = 0;
  const actions = createMigrationActions({
    config: { pds: [] },
    accounts: { placement: { choices: async () => [] } },
    console: { needed() {} },
    migration: {
      status: async () => saved,
      importAccount: async () => {
        dispatched++;
      },
      requestMigrationForBrowser: async () => {
        throw Error("unexpected proof");
      },
    },
  });
  const res = {
    set() {},
    status() {
      return this;
    },
    type() {
      return this;
    },
    send(html) {
      return html;
    },
  };
  const common = {
    res,
    account: { did: "did:plc:test", pdsId: "source" },
    browser: { csrf: "x" },
    principal: {},
    accountContext: { did: "did:plc:test" },
    value: (key) => (key === "pdsId" ? "drained" : ""),
    token: () => "code",
  };
  await assert.rejects(
    actions["migration-request"](common),
    /Choose an available/,
  );
  assert.equal(dispatched, 0);
  const html = await actions["migration-confirm"](common);
  assert.equal(dispatched, 1);
  assert.match(html, /drained/);
});

test("static forms retain their default and completed move can be replayed", async () => {
  const config = {
    pds: [{ id: "host", url: "https://host.test" }],
    handleDomains: ["test"],
  };
  const form = createSignupForm({
    db: { list: async () => [] },
    config,
    accounts: { get: async () => null },
    fields: () => "",
  });
  assert.doesNotMatch(await form({}, {}), /Choose a data server/);
  const staticPanel = renderMigrationPanel({
    config,
    a: { pdsId: "source" },
    csrf: "x",
    accountContext: { did: "did:plc:test" },
    migration: {},
  });
  assert.doesNotMatch(staticPanel, /Choose a data server/);
  const { createMigrationActions } =
    await import("../../../dist/src/features/pds-migration/actions.mjs");
  let calls = 0;
  const actions = createMigrationActions({
    config: { pds: [] },
    accounts: { placement: { choices: async () => [] } },
    console: { needed() {} },
    migration: {
      status: async () => ({ targetPdsId: "host", phase: "complete" }),
      importAccount: async () => {
        calls++;
      },
    },
  });
  const res = {
    set() {},
    status() {
      return this;
    },
    type() {
      return this;
    },
    send(html) {
      return html;
    },
  };
  const input = {
    res,
    account: { did: "did:plc:test", pdsId: "host" },
    browser: { csrf: "x" },
    principal: {},
    accountContext: { did: "did:plc:test" },
    value: (key) => (key === "pdsId" ? "host" : ""),
    token: () => "code",
  };
  await assert.rejects(
    actions["migration-request"](input),
    /Choose an available/,
  );
  await actions["migration-confirm"](input);
  assert.equal(calls, 1);
});
