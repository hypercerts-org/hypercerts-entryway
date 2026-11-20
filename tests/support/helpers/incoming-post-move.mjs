import { expect } from "@playwright/test";
import { call, json } from "./incoming-journey.mjs";

async function expectDeactivatedWrite(origin, did, token) {
  const write = await call(origin, "com.atproto.repo.createRecord", {
    token,
    body: {
      repo: did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text: "After deactivation",
        createdAt: new Date().toISOString(),
      },
    },
  });
  expect(write.status, "deactivated source accessJwt write").toBe(401);
  expect(
    json(write).error === "AccountDeactivated",
    "stock deactivation error",
  ).toBe(true);
}

export async function expectSourceCutover(origin, source) {
  await expectDeactivatedWrite(origin, source.did, source.accessJwt);
  const refresh = await fetch(
    new URL("/xrpc/com.atproto.server.refreshSession", origin),
    {
      method: "POST",
      headers: { authorization: `Bearer ${source.refreshJwt}` },
    },
  );
  expect(refresh.status === 200, "deactivated source refresh").toBe(true);
  const rotated = await refresh.json();
  expect(rotated.did === source.did, "source DID retained").toBe(true);
  expect(rotated.active === false, "source remains inactive").toBe(true);
  expect(rotated.status === "deactivated", "source status").toBe(true);
  expect(
    typeof rotated.accessJwt === "string" && rotated.accessJwt.length > 0,
    "rotated access token issued",
  ).toBe(true);
  await expectDeactivatedWrite(origin, source.did, rotated.accessJwt);
}

export async function expectSdkWrite(page, sdk, { did, endpoint, text }) {
  expect(endpoint, "prepared endpoint must match the browser fixture PDS").toBe(
    sdk.config.pds[0].url,
  );
  const [response, readback] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url() ===
          new URL("/xrpc/com.atproto.repo.createRecord", endpoint).href &&
        candidate.request().method() === "POST" &&
        candidate.ok(),
    ),
    sdk.createPost(page, text, did),
  ]);
  const headers = await response.request().allHeaders();
  expect(
    Boolean(headers.dpop) && /^DPoP /i.test(headers.authorization),
    "DPoP-bound write",
  ).toBe(true);
  expect(readback.origin, "SDK audience-derived readback endpoint").toBe(
    endpoint,
  );
  return headers.authorization;
}

export function matchesGrant(authorization, grant) {
  return (
    typeof grant.access_token === "string" &&
    grant.access_token.length > 0 &&
    authorization === `DPoP ${grant.access_token}`
  );
}

export function tokenGrant(issuer, grantType) {
  return (candidate) =>
    candidate.url() === new URL("/oauth/token", issuer).href &&
    candidate.request().method() === "POST" &&
    candidate.ok() &&
    new URLSearchParams(candidate.request().postData()).get("grant_type") ===
      grantType;
}

export async function expectSdkAction(
  page,
  { issuer, path, button, grantType },
) {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const request = candidate.request();
      return (
        candidate.url() === new URL(path, issuer).href &&
        request.method() === "POST" &&
        (!grantType ||
          new URLSearchParams(request.postData()).get("grant_type") ===
            grantType) &&
        candidate.ok()
      );
    }),
    page.getByRole("button", { name: button }).click(),
  ]);
  expect(response.ok(), `${path} succeeded`).toBe(true);
  return response;
}
