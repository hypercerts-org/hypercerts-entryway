import { test, expect } from "@playwright/test";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { decodeJwt, exportJWK, importJWK, SignJWT } from "jose";
import { loadConfig } from "../../dist/src/config.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createAccount } from "../support/helpers/browser-oauth.mjs";
import { nodeRouting } from "../support/helpers/incoming-nodes.mjs";
import { beginAuthorization, finishConsent } from "./support/oauth-client.mjs";

const config = await loadConfig();
const nodes = nodeRouting(config.issuer, ["entryway", "entryway-replica"]);

async function proof(jwk, url, method, nonce, token) {
  const alg = jwk.alg ?? (jwk.crv === "P-256" ? "ES256" : "ES256K");
  const key = await importJWK(jwk, alg);
  const publicKey = await exportJWK(createPublicKey(key));
  return new SignJWT({
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    htm: method,
    htu: url,
    ...(nonce ? { nonce } : {}),
    ...(token
      ? { ath: createHash("sha256").update(token).digest("base64url") }
      : {}),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg, jwk: publicKey })
    .sign(key);
}

async function refresh(db, client, session, role) {
  const url = `${config.issuer}/oauth/token`;
  const clientId = `${config.clientUrl}/client-metadata${client === "secondary" ? "-secondary" : ""}.json`;
  const jwk = await db.get("client:keys", client);
  const key = await importJWK(jwk, "ES256");
  let nonce;
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({
      iss: clientId,
      sub: clientId,
      aud: config.issuer,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" })
      .sign(key);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...nodes.headers(role),
        "content-type": "application/x-www-form-urlencoded",
        dpop: await proof(session.dpopJwk, url, "POST", nonce),
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        grant_type: "refresh_token",
        refresh_token: session.tokenSet.refresh_token,
      }),
    });
    nodes.expectServed(response, `${client} refresh`);
    const body = await response.json();
    nonce = response.headers.get("dpop-nonce");
    if (body.error === "use_dpop_nonce" && attempt === 0) continue;
    return { response, body };
  }
  throw Error("DPoP nonce negotiation failed");
}

async function write(session, did, token, label) {
  const endpoint = `${config.pds[0].url}/xrpc/com.atproto.repo.createRecord`;
  let nonce;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await proof(session.dpopJwk, endpoint, "POST", nonce, token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repo: did,
        collection: "org.hypercerts.spike.note",
        validate: false,
        record: {
          $type: "org.hypercerts.spike.note",
          text: label,
          createdAt: new Date().toISOString(),
        },
      }),
    });
    nonce = response.headers.get("dpop-nonce");
    if (response.status === 401 && nonce && attempt === 0) continue;
    return response;
  }
  throw Error("PDS DPoP nonce negotiation failed");
}

test("cross-node grant revocation and held access token expiry", async ({
  page,
}) => {
  test.setTimeout(480_000);
  await nodes.load();
  const db = await openDatabase(config.database);
  try {
    const identity = await createAccount(page, "lifecycle-live");
    for (const client of ["primary", "secondary"]) {
      await beginAuthorization(page, {
        client,
        identifier: config.issuer,
        prompt: "consent",
      });
      await finishConsent(page, identity.did);
    }
    const primary = await db.get("client:primary:sessions", identity.did);
    const secondary = await db.get("client:secondary:sessions", identity.did);
    const held = primary.tokenSet.access_token;
    const { exp } = decodeJwt(held);
    expect(Number.isInteger(exp)).toBe(true);
    expect(exp * 1000 - Date.now()).toBeGreaterThan(10_000);
    await nodes.stage(
      "revoke",
      0,
      identity.did,
      async () => {
        await page.goto(`${config.issuer}/account`);
        const form = page
          .locator('form[action="/account/grant-revoke"]')
          .filter({
            has: page.locator(
              `input[name="clientId"][value="${config.clientUrl}/client-metadata.json"]`,
            ),
          });
        const response = page.waitForResponse(
          (r) =>
            r.url() === `${config.issuer}/account/grant-revoke` &&
            r.request().method() === "POST",
        );
        await form
          .getByRole("button", { name: "Revoke application access" })
          .click();
        nodes.expectServed(await response, "grant revocation");
        expect((await response).status()).toBe(303);
      },
      { page },
    );
    await nodes.stage("refresh", 1, identity.did, async () => {
      const revoked = await refresh(db, "primary", primary, 1);
      expect(revoked.response.status).toBe(400);
      expect(revoked.body.error).toBe("invalid_grant");
      const control = await refresh(db, "secondary", secondary, 1);
      expect(control.response.status).toBe(200);
      expect(control.body.sub).toBe(identity.did);
      secondary.tokenSet = control.body;
    });
    nodes.expectAlternation(["revoke", "refresh"], identity.did);
    expect(
      (await write(primary, identity.did, held, "before expiry")).status,
    ).toBe(200);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, exp * 1000 - Date.now() + 2_000)),
    );
    expect(
      (await write(primary, identity.did, held, "after expiry")).status,
    ).toBe(401);
    const control = await nodes.stage("control refresh", 1, identity.did, () =>
      refresh(db, "secondary", secondary, 1),
    );
    expect(control.response.status).toBe(200);
    expect(
      (
        await write(
          secondary,
          identity.did,
          control.body.access_token,
          "expiry control",
        )
      ).status,
    ).toBe(200);
  } finally {
    await db.close();
  }
});
