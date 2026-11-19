import { expect } from "@playwright/test";
import { readCarWithRoot } from "@atproto/repo";
import { waitForMailpitCode } from "./mailpit.mjs";

// Shared by the public and goat incoming journeys, which differ only in the
// migration client. The browser step and the XRPC call helper live here so the
// two journeys cannot drift apart.

export async function call(
  origin,
  method,
  { token, body, params, bytes, type } = {},
) {
  const url = new URL(`/xrpc/${method}`, origin);
  for (const [key, value] of Object.entries(params ?? {}))
    url.searchParams.set(key, value);
  const post =
    body !== undefined ||
    bytes !== undefined ||
    /(requestPlcOperationSignature|activateAccount|deactivateAccount)$/.test(
      method,
    );
  const response = await fetch(url, {
    method: post ? "POST" : "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(bytes === undefined ? {} : { "content-type": type }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(bytes === undefined ? {} : { body: bytes }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const content = Buffer.from(await response.arrayBuffer());
  return { status: response.status, content, headers: response.headers };
}

export const json = ({ content }) =>
  JSON.parse(content.toString("utf8") || "{}");

// Status only: bodies of failed calls can echo credentials.
export const ok = (response, what) =>
  expect(response.status, `${what} status`).toBeLessThan(300);

// The error name only: a refusal body can echo request details.
export const errorName = ({ content }) => {
  try {
    const { error } = JSON.parse(content.toString("utf8"));
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
};

// Header frame first, then one frame per block: varint length, 36-byte CID, data.
function carFrames(car) {
  const frames = [];
  let offset = 0;
  while (offset < car.length) {
    const start = offset;
    let size = 0;
    let scale = 1;
    let byte;
    do {
      byte = car[offset++];
      size += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    frames.push({ start, data: offset, end: offset + size });
    offset += size;
  }
  expect(offset, "whole CAR frames").toBe(car.length);
  return frames;
}

/**
 * Malformed variants of a verified export, for import refusal checks:
 * - `tampered`: one byte of the named record's text changed in place, so the
 *   framing and the DAG-CBOR stay valid but the block no longer hashes to its CID;
 * - `cutMidBlock`: cut half-way through the data of the block at the midpoint;
 * - `cutAtBlock`: every whole frame except the final block.
 */
export async function malformedCars(car, record) {
  const frames = carFrames(car);
  const { blocks } = await readCarWithRoot(car);
  const block = blocks.entries().find((entry) => `${entry.cid}` === record.cid);
  const frame = frames
    .slice(1)
    .find(({ data }) => car.subarray(data, data + 36).equals(block.cid.bytes));
  const text = car
    .subarray(frame.data + 36, frame.end)
    .indexOf(Buffer.from(record.value.text));
  expect(text, "record text in its block").toBeGreaterThan(0);
  const tampered = Buffer.from(car);
  tampered[frame.data + 36 + text] ^= 0x01;
  const middle = frames
    .slice(1)
    .find(({ end }) => end > Math.floor(car.length / 2));
  const cut = Math.floor((middle.data + 36 + middle.end) / 2);
  expect(
    middle.data + 36 < cut && cut < middle.end,
    "cut ends inside block data",
  ).toBe(true);
  const last = frames.at(-1);
  return {
    tampered,
    cutMidBlock: car.subarray(0, cut),
    cutAtBlock: car.subarray(0, last.start),
    droppedBlock: `${blocks.entries().find((entry) => car.subarray(last.data, last.data + 36).equals(entry.cid.bytes)).cid}`,
  };
}

// Verifies the destination email in the browser, asks for a fresh code and
// prepares the arrival. Returns the values the page shows once.
export async function prepareArrival(
  page,
  { issuer, mailpitUrl, did, handle, email },
) {
  const since = Date.now();
  await page.goto(`${issuer}/login`);
  await page.getByLabel("Email address").first().fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const login = await waitForMailpitCode({
    recipient: email,
    since,
    baseUrl: mailpitUrl,
  });
  await page.getByLabel("Sign-in code").evaluate((input, code) => {
    input.value = code;
  }, login.code);
  await page.getByRole("button", { name: "Verify code" }).click();
  // A verified session exists even though no account does yet.
  await page.goto(`${issuer}/incoming`);
  await expect(
    page.getByRole("heading", { name: "Incoming migration" }),
  ).toBeVisible();
  // The service sends a fresh code to the verified email on request.
  await page.waitForTimeout(6_000);
  const asked = Date.now();
  await page
    .getByRole("button", { name: "Send me a fresh email code" })
    .click();
  const fresh = await waitForMailpitCode({
    recipient: email,
    since: asked,
    excludeIds: [login.messageId],
    baseUrl: mailpitUrl,
  });
  await page.goto(`${issuer}/incoming`);
  await page.getByLabel("Your DID").fill(did);
  await page.getByLabel("Destination handle").fill(handle);
  await page.getByLabel("Fresh email code").evaluate((input, code) => {
    input.value = code;
  }, fresh.code);
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/incoming/prepare") &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Prepare arrival" }).click();
  const prepared = await response;
  expect(prepared.status()).toBe(200);
  expect(prepared.headers()["cache-control"]).toBe("no-store");
  await expect(page.getByText("shown once")).toBeVisible();
  const fields = await page
    .locator("dl.identity")
    .evaluate((list) =>
      Object.fromEntries(
        [...list.querySelectorAll("dt")].map((term) => [
          term.textContent,
          term.nextElementSibling.textContent,
        ]),
      ),
    );
  const arrival = {
    operationId: fields.operationId,
    version: Number(fields.version),
    arrivalCode: fields.arrivalCode,
    handoff: JSON.parse(fields.handoff),
    destinationEndpoint: fields.destinationEndpoint,
  };
  // Booleans only: a failing assertion must never print the code.
  expect(/^[A-Za-z0-9_-]{32}$/.test(arrival.arrivalCode)).toBe(true);
  expect(arrival.destinationEndpoint).toBeTruthy();
  // No credential or code appears in any URL.
  expect(page.url().includes(arrival.arrivalCode)).toBe(false);
  return arrival;
}

export const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function readPages(endpoint, method, params, field) {
  const items = [];
  const seen = new Set();
  let cursor;
  do {
    const response = await call(endpoint, method, {
      params: { ...params, limit: 1, ...(cursor ? { cursor } : {}) },
    });
    ok(response, method);
    const page = json(response);
    expect(Array.isArray(page[field])).toBe(true);
    items.push(...page[field]);
    cursor = page.cursor;
    if (cursor !== undefined) {
      expect(
        typeof cursor === "string" && cursor.length > 0 && !seen.has(cursor),
        "new page cursor",
      ).toBe(true);
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}

async function snapshot(endpoint, did) {
  const description = await call(endpoint, "com.atproto.repo.describeRepo", {
    params: { repo: did },
  });
  ok(description, "describe repository");
  const records = [];
  for (const collection of json(description).collections.sort()) {
    records.push(
      ...(await readPages(
        endpoint,
        "com.atproto.repo.listRecords",
        { repo: did, collection },
        "records",
      )),
    );
  }
  const blobs = [];
  for (const cid of (
    await readPages(endpoint, "com.atproto.sync.listBlobs", { did }, "cids")
  ).sort()) {
    const response = await call(endpoint, "com.atproto.sync.getBlob", {
      params: { did, cid },
    });
    ok(response, "fetch blob");
    blobs.push({ cid, bytes: response.content });
  }
  return { records: records.sort((a, b) => a.uri.localeCompare(b.uri)), blobs };
}

// Compare the source's public inventory to the writes, independently of import.
export async function createSourceAccount(
  access,
  { unique, email, password, displayName, shape },
) {
  const description = json(
    await call(access.sourceUrl, "com.atproto.server.describeServer"),
  );
  const handle = `s${unique}${description.availableUserDomains[0]}`;
  const created = await call(
    access.sourceUrl,
    "com.atproto.server.createAccount",
    {
      body: { email, password, handle },
    },
  );
  ok(created, "source account");
  const source = json(created);
  const blobs = [];
  let avatar;
  if (shape === "blob-bearing" || shape === "multi-collection") {
    const uploaded = await call(
      access.sourceUrl,
      "com.atproto.repo.uploadBlob",
      {
        token: source.accessJwt,
        bytes: pixel,
        type: "image/png",
      },
    );
    ok(uploaded, "source blob");
    avatar = json(uploaded).blob;
    blobs.push({ cid: avatar.ref.$link, bytes: pixel });
  }
  const records = [];
  async function put(rkey, value) {
    const collection = value.$type;
    const response = await call(
      access.sourceUrl,
      "com.atproto.repo.putRecord",
      {
        token: source.accessJwt,
        body: { repo: source.did, collection, rkey, record: value },
      },
    );
    ok(response, "source record");
    const { cid, uri } = json(response);
    expect(uri).toBe(`at://${source.did}/${collection}/${rkey}`);
    expect(typeof cid).toBe("string");
    records.push({ uri, cid, value });
  }
  if (shape !== "empty")
    await put("self", {
      $type: "app.bsky.actor.profile",
      displayName,
      ...(avatar ? { avatar } : {}),
    });
  if (shape === "multi-collection")
    for (const rkey of ["3mznesxxhic2e", "3mznesxxhic2f"])
      await put(rkey, {
        $type: "app.bsky.feed.post",
        text: rkey,
        createdAt: new Date().toISOString(),
      });
  const inventory = await snapshot(access.sourceUrl, source.did);
  expect(inventory).toEqual({ records, blobs });
  return { source, inventory, handle };
}

// The destination serves the record and the blob byte for byte, and the PLC
// directory names the destination endpoint and handle.
export async function expectDestinationServes(
  access,
  { endpoint, did, inventory, handle },
) {
  expect(await snapshot(endpoint, did)).toEqual(inventory);
  const document = await (
    await fetch(new URL(`/${did}`, access.plcUrl))
  ).json();
  expect(
    document.service.find((service) => service.id === "#atproto_pds")
      .serviceEndpoint,
  ).toBe(endpoint);
  expect(document.alsoKnownAs).toContain(`at://${handle}`);
}

/**
 * Registers the two opening steps every incoming journey shares: a standalone
 * source account with a record and a blob, then the browser email proof and
 * arrival preparation. `context` returns the sandbox access and service config
 * loaded by the spec's own `beforeAll`; `onPrepared` runs after preparation.
 */
export function registerArrivalSetup(
  test,
  {
    context,
    run,
    unique,
    sourceEmail,
    sourcePassword,
    destinationEmail,
    displayName,
    onPrepared,
  },
) {
  test("the standalone source serves the seeded inventory", async () => {
    const { access, config } = context();
    const created = await createSourceAccount(access, {
      unique,
      email: sourceEmail,
      password: sourcePassword,
      shape: test.info().project.metadata.shape ?? "blob-bearing",
      displayName,
    });
    run.source = created.source;
    run.inventory = created.inventory;
    run.sourceHandle = created.handle;
    run.destinationHandle = `d${unique}${config.handleDomains[0]}`;
    expect(run.sourceHandle).not.toBe(run.destinationHandle);
  });

  test("the browser verifies the destination email and prepares the arrival", async ({
    page,
  }) => {
    const { access, config } = context();
    run.prepared = await prepareArrival(page, {
      issuer: config.issuer,
      mailpitUrl: access.mailpitUrl,
      did: run.source.did,
      handle: run.destinationHandle,
      email: destinationEmail,
    });
    await onPrepared?.(page);
  });
}
