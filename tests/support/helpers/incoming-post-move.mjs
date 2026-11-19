import { expect } from "@playwright/test";
import { call, json } from "./incoming-journey.mjs";

export async function expectSourceSessionsRefused(origin, source) {
  const write = await call(origin, "com.atproto.repo.createRecord", {
    token: source.accessJwt,
    body: {
      repo: source.did,
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
  const refresh = await fetch(
    new URL("/xrpc/com.atproto.server.refreshSession", origin),
    {
      method: "POST",
      headers: { authorization: `Bearer ${source.refreshJwt}` },
    },
  );
  expect(refresh.status, "deactivated source refresh").toBe(400);
}

export async function expectSdkWrite(
  page,
  createPost,
  { did, endpoint, text },
) {
  const [response, readback] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url() ===
          new URL("/xrpc/com.atproto.repo.createRecord", endpoint).href &&
        candidate.request().method() === "POST" &&
        candidate.ok(),
    ),
    createPost(page, text, did),
  ]);
  const headers = await response.request().allHeaders();
  expect(
    Boolean(headers.dpop) && /^DPoP /i.test(headers.authorization),
    "DPoP-bound write",
  ).toBe(true);
  expect(readback.origin, "SDK audience-derived readback endpoint").toBe(
    endpoint,
  );
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
}
