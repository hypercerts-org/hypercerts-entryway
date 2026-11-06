import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as plc from "@did-plc/lib";
import { waitForStockPlcMessage } from "../support/helpers/stock-plc-mailpit.mjs";

test(
  "standalone public signup and PLC confirmation preflight",
  { skip: !process.env.INCOMING_PUBLIC_MECHANISMS, timeout: 90000 },
  async () => {
    if (!process.env.INCOMING_ACCESS_PATH || !process.env.INCOMING_PROJECT)
      throw new Error("Missing managed projection or project");
    const access = JSON.parse(
      await readFile(process.env.INCOMING_ACCESS_PATH, "utf8"),
    );
    if (
      access.schemaVersion !== 1 ||
      access.project !== process.env.INCOMING_PROJECT
    )
      throw new Error("Projection project mismatch");
    for (const value of [
      access.sourceUrl,
      access.entrywayUrl,
      access.plcUrl,
      access.mailpitUrl,
      ...(access.destinationUrls ?? []),
    ]) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.origin !== value
      )
        throw new Error("Invalid projection origin");
    }
    if (
      !Array.isArray(access.destinationUrls) ||
      access.destinationUrls.length !== 2
    )
      throw new Error("Missing destination projection");
    const request = async (method, body, token, verb = "POST") => {
      const response = await fetch(`${access.sourceUrl}/xrpc/${method}`, {
        method: verb,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(`Public ${method} failed with HTTP ${response.status}`);
      return response.json().catch(() => ({}));
    };
    const description = await request(
      "com.atproto.server.describeServer",
      undefined,
      undefined,
      "GET",
    );
    if (
      description.inviteCodeRequired ||
      !Array.isArray(description.availableUserDomains) ||
      !description.availableUserDomains[0]
    )
      throw new Error("Standalone signup unavailable");
    const unique = randomUUID().replaceAll("-", "");
    const email = `public-${unique}@example.com`;
    const password = `Public-${randomUUID()}!`;
    const handle = `u${unique.slice(0, 16)}${description.availableUserDomains[0]}`;
    const account = await request("com.atproto.server.createAccount", {
      email,
      password,
      handle,
    });
    if (typeof account.did !== "string") throw new Error("Signup omitted DID");
    const session = await request("com.atproto.server.createSession", {
      identifier: account.did,
      password,
    });
    if (session.did !== account.did || typeof session.accessJwt !== "string")
      throw new Error("Session did not match account");
    const search = new URL("/api/v1/search", access.mailpitUrl);
    search.searchParams.set("query", `to:${email}`);
    search.searchParams.set("limit", "50");
    const prior = await fetch(search, { signal: AbortSignal.timeout(10000) });
    if (!prior.ok) throw new Error("Mailpit search failed");
    const priorMessages = await prior.json();
    if (!Array.isArray(priorMessages.messages))
      throw new Error("Invalid Mailpit search");
    const excludeIds = priorMessages.messages.map((item) => item.ID);
    const since = Date.now();
    await request(
      "com.atproto.identity.requestPlcOperationSignature",
      undefined,
      session.accessJwt,
    );
    const confirmation = await waitForStockPlcMessage({
      recipient: email,
      since,
      excludeIds,
      baseUrl: access.mailpitUrl,
    });
    const initial = await new plc.Client(access.plcUrl).getLastOp(account.did);
    const signed = await request(
      "com.atproto.identity.signPlcOperation",
      { token: confirmation.token },
      session.accessJwt,
    );
    if (!signed.operation) throw new Error("PLC signing omitted operation");
    await plc.assureValidSig(initial.rotationKeys, signed.operation);
    assert.ok(true, "Public signing verified");
  },
);
