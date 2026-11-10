import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import * as plc from "@did-plc/lib";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";

// This explicit qualification creates its own account through browser proof.
// No SQL, private fixture API or operator signing key establishes DID authority.
test(
  "public PLC key addition and independent destination departure",
  { skip: !process.env.PUBLIC_PLC_QUALIFICATION },
  async () => {
    const { chromium } = await import("playwright");
    const { createAccount } =
      await import("../support/helpers/browser-oauth.mjs");
    const config = JSON.parse(
      readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"),
    );
    const receipts = [];
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const identity = await createAccount(page, "custody");
      const password = `Public qualification ${randomUUID()}!`;
      const form = page.locator('form[action="/account/password-set"]');
      await form.getByLabel("New account password").fill(password);
      await form.getByRole("button").click();
      const source = config.pds[0];
      const request = async (origin, nsid, body, token, method = "POST") => {
        const response = await fetch(`${origin}/xrpc/${nsid}`, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await response.json().catch(() => ({}));
        return { status: response.status, data };
      };
      const login = await request(
        source.url,
        "com.atproto.server.createSession",
        { identifier: identity.did, password },
      );
      assert.equal(login.status, 200, login.data.error);
      const session = login.data.accessJwt;
      const confirmation = async () => {
        const since = Date.now();
        const sent = await request(
          source.url,
          "com.atproto.identity.requestPlcOperationSignature",
          undefined,
          session,
        );
        assert.equal(sent.status, 200, sent.data.error);
        return (await waitForMailpitCode({ recipient: identity.email, since }))
          .code;
      };
      const client = new plc.Client(config.plcUrl);
      const initial = await client.getLastOp(identity.did);
      const user = await Secp256k1Keypair.create();
      const signed = await request(
        source.url,
        "com.atproto.identity.signPlcOperation",
        {
          token: await confirmation(),
          rotationKeys: [user.did(), ...initial.rotationKeys],
        },
        session,
      );
      assert.equal(signed.status, 200, signed.data.error);
      await plc.assureValidSig(initial.rotationKeys, signed.data.operation);
      const submitted = await request(
        source.url,
        "com.atproto.identity.submitPlcOperation",
        signed.data,
        session,
      );
      assert.equal(submitted.status, 200, submitted.data.error);
      const added = await client.getLastOp(identity.did);
      assert.equal(
        String(await cidForCbor(added)),
        String(await cidForCbor(signed.data.operation)),
      );
      assert.deepEqual(added.rotationKeys, [
        user.did(),
        ...initial.rotationKeys,
      ]);
      receipts.push({
        case: "public-user-key-addition",
        status: "PASS",
        cid: String(await cidForCbor(added)),
      });

      // The independent stock PDS is identified from its declared public configuration.
      const destination = { url: process.env.PUBLIC_PLC_DESTINATION };
      assert.ok(
        destination.url,
        "Explicit destination public endpoint required",
      );
      const description = await request(
        destination.url,
        "com.atproto.server.describeServer",
        undefined,
        undefined,
        "GET",
      );
      assert.equal(description.status, 200);
      const service = await request(
        `${source.url}`,
        `com.atproto.server.getServiceAuth?aud=${encodeURIComponent(description.data.did)}&lxm=com.atproto.server.createAccount`,
        undefined,
        session,
        "GET",
      );
      assert.equal(service.status, 200, service.data.error);
      const prepared = await request(
        destination.url,
        "com.atproto.server.createAccount",
        {
          did: identity.did,
          handle: identity.handle,
          email: `destination-${randomUUID()}@example.com`,
          password,
          deactivated: true,
        },
        service.data.token,
      );
      receipts.push({
        case: "independent-destination-preparation",
        status: prepared.status === 200 ? "PASS" : "BLOCKED",
        httpStatus: prepared.status,
        error: prepared.data.error ?? null,
      });
      if (prepared.status !== 200)
        throw new Error(
          `PublicDestinationPreparationBlocked:${prepared.status}:${prepared.data.error}`,
        );
      const recommended = await request(
        destination.url,
        "com.atproto.identity.getRecommendedDidCredentials",
        undefined,
        prepared.data.accessJwt,
        "GET",
      );
      assert.equal(recommended.status, 200, recommended.data.error);
      const departure = await request(
        source.url,
        "com.atproto.identity.signPlcOperation",
        { ...recommended.data, token: await confirmation() },
        session,
      );
      assert.equal(departure.status, 200, departure.data.error);
      assert.ok(
        !departure.data.operation.rotationKeys.includes(
          config.plcRotationKeyDid,
        ),
      );
      const published = await request(
        destination.url,
        "com.atproto.identity.submitPlcOperation",
        departure.data,
        prepared.data.accessJwt,
      );
      assert.equal(published.status, 200, published.data.error);
      const departed = await client.getLastOp(identity.did);
      assert.equal(
        String(await cidForCbor(departed)),
        String(await cidForCbor(departure.data.operation)),
      );
      assert.deepEqual(departed.rotationKeys, recommended.data.rotationKeys);
      receipts.push({
        case: "public-departure-publication",
        status: "PASS",
        cid: String(await cidForCbor(departed)),
      });
      // The departed PDS cannot proxy repository-authenticated requests anymore.
      // Direct Entryway auth tests signer rejection before proof consumption.
      const refused = await request(
        config.issuer,
        "com.atproto.identity.signPlcOperation",
        { token: "not-consumed-without-authority" },
        session,
      );
      assert.equal(refused.status, 400);
      assert.equal(refused.data.error, "InvalidPlcOperation");
      receipts.push({
        case: "public-departure-and-source-authority-loss",
        status: "PASS",
        cid: String(await cidForCbor(departed)),
      });
    } finally {
      await browser.close();
      writeFileSync(
        "/app/artifacts/public-plc-qualification.json",
        JSON.stringify(receipts, null, 2),
      );
    }
  },
);
