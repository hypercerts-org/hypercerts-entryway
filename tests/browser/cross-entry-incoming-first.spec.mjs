import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  createSourceAccount,
  prepareArrival,
  call,
  json,
} from "../support/helpers/incoming-journey.mjs";
import {
  arrivalSummary,
  creationMethod,
  destinationRepoStatus,
  handoffMethod,
  inviteFields,
  plcAudit,
  serviceAuth,
  signHandoff,
} from "../support/helpers/incoming-failures.mjs";
import { loadConfig } from "../../dist/src/config.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { nodeRouting } from "../support/helpers/incoming-nodes.mjs";

test("pending stock incoming arrival refuses the authenticated managed console on the other node", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const access = JSON.parse(
    readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"),
  );
  expect(access.project).toBe(process.env.INCOMING_PROJECT);
  const config = JSON.parse(
    readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"),
  );
  const nodes = nodeRouting(config.issuer, ["entryway", "entryway-replica"]);
  await nodes.load();
  const tag = randomUUID().replaceAll("-", "").slice(0, 16);
  const sourceEmail = `cross-source-${tag}@example.com`;
  const email = `cross-arrival-${tag}@example.com`;
  const handle = `d${tag}${config.handleDomains[0]}`;
  const { source } = await createSourceAccount(access, {
    unique: tag,
    email: sourceEmail,
    password: `Cross-${randomUUID()}!`,
    shape: "empty",
  });
  const prepared = await nodes.stage(
    "prepare",
    0,
    source.did,
    () =>
      prepareArrival(page, {
        issuer: config.issuer,
        access,
        mailpitUrl: access.mailpitUrl,
        did: source.did,
        handle,
        email,
      }),
    { page },
  );
  const operation = await signHandoff(access, {
    source,
    sourceEmail,
    handoff: prepared.handoff,
  });
  const submit = async (method, body) => {
    const response = await call(config.issuer, method, {
      token: await serviceAuth(access, config, source, method),
      headers: {
        ...nodes.headers(0),
        "entryway-arrival-code": prepared.arrivalCode,
      },
      body,
    });
    nodes.expectServed(response, method);
    expect(response.status).toBe(200);
    return json(response);
  };
  await nodes.stage("handoff", 0, source.did, () =>
    submit(handoffMethod, { operation }),
  );
  const created = await nodes.stage("creation", 0, source.did, async () =>
    submit(creationMethod, { handle, ...(await inviteFields(config)) }),
  );
  expect(created.did).toBe(source.did);
  expect(created.active).toBe(false);
  const before = await nodes.stage(
    "saved arrival",
    0,
    source.did,
    () => arrivalSummary(page, config, prepared.operationId),
    { page },
  );
  const database = await openDatabase((await loadConfig()).database);
  const active = async () =>
    (await database.read("active_did_transfers")).filter(
      (row) => row.did === source.did,
    );
  const claim = await active();
  expect(claim).toEqual([
    {
      did: source.did,
      operation_id: prepared.operationId,
      transfer_kind: "incoming",
    },
  ]);
  const audit = await plcAudit(access, source.did);
  const repo = await destinationRepoStatus(
    prepared.destinationEndpoint,
    source.did,
  );
  await nodes.stage(
    "managed console refusal",
    1,
    source.did,
    async () => {
      const response = await page.goto(`${config.issuer}/account`);
      nodes.expectServed(response, "account");
      expect(response.status()).toBe(409);
      await expect(page.locator("h1")).toHaveText("Migration in progress");
    },
    { page },
  );
  const after = await nodes.stage(
    "saved arrival after refusal",
    0,
    source.did,
    () => arrivalSummary(page, config, prepared.operationId),
    { page },
  );
  expect(after).toEqual(before);
  expect(await active()).toEqual(claim);
  await database.close();
  expect(isDeepStrictEqual(await plcAudit(access, source.did), audit)).toBe(
    true,
  );
  expect(
    await destinationRepoStatus(prepared.destinationEndpoint, source.did),
  ).toEqual(repo);
});
