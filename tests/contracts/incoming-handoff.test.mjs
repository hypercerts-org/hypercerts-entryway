import assert from "node:assert/strict";
import test from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  ArrivalPdsClient,
  reservationSigningKey,
} from "../../dist/src/pds/arrival-client.js";
const hosts = [
  { id: "pds1", url: "https://pds1.example.test" },
  { id: "pds2", url: "https://pds2.example.test" },
];
const endpoint = hosts[0].url;
const did = `did:plc:${"a".repeat(24)}`;
const handle = "dest.entryway.test";

/** Replace fetch for the duration of one observation and always restore it. */
async function serving(handler, observe) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push({ url: String(url), init });
    return await handler(url, init ?? {});
  };
  try {
    return { result: await observe(), requests };
  } finally {
    globalThis.fetch = original;
  }
}

test("stock reservation is unauthenticated, sends only the DID and never echoes binding facts", async () => {
  const reservationKey = (
    await Secp256k1Keypair.create({ exportable: true })
  ).did();
  const client = new ArrivalPdsClient({
    endpoint,
    did,
  });
  const { result, requests } = await serving(
    async () =>
      new Response(JSON.stringify({ signingKey: reservationKey }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    () => client.reserveSigningKey(did),
  );
  assert.equal(result, reservationKey);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://pds1.example.test/xrpc/com.atproto.server.reserveSigningKey",
  );
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get("authorization"), null);
  assert.deepEqual(JSON.parse(requests[0].init.body), { did });
});

test("a stock reservation HTTP error, malformed body or unsupported key is refused", async () => {
  const client = new ArrivalPdsClient({
    endpoint,
    did,
  });
  const respond = (status, body) => async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  for (const handler of [
    respond(503, JSON.stringify({ error: "ServiceUnavailable" })),
    respond(200, "not json"),
    respond(200, JSON.stringify({ signingKey: 42 })),
    respond(200, JSON.stringify({ signingKey: "did:key:zDnae-invalid" })),
    respond(
      200,
      JSON.stringify({ signingKey: `did:key:z6Mk${"a".repeat(44)}` }),
    ),
  ])
    await serving(handler, async () => {
      await assert.rejects(client.reserveSigningKey(did), {
        code: "AccountUnavailable",
      });
    });
  // The stock contract echoes no DID or host; extra fields cannot become binding
  // facts, and only the validated public key survives.
  const reservationKey = (
    await Secp256k1Keypair.create({ exportable: true })
  ).did();
  const echoed = await serving(
    respond(
      200,
      JSON.stringify({
        signingKey: reservationKey,
        did: "did:plc:other",
        endpoint,
      }),
    ),
    () => client.reserveSigningKey(did),
  );
  assert.equal(echoed.result, reservationKey);
  // A validated public key is returned as-is; anything else is not a reservation.
  assert.equal(
    reservationSigningKey({
      signingKey: `did:key:zQ3sh${"a".repeat(44)}`,
    }),
    `did:key:zQ3sh${"a".repeat(44)}`,
  );
});

test("destination creation sends only the exact move and returns no session to callers", async () => {
  const client = new ArrivalPdsClient({
    endpoint,
    did,
  });
  const operation = { type: "plc_operation", prev: `bafyrei${"a".repeat(52)}` };
  const { result, requests } = await serving(
    async () =>
      new Response(
        JSON.stringify({
          did,
          handle,
          accessJwt: "access",
          refreshJwt: "refresh",
          didDoc: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    () => client.createAccount({ did, handle, operation }),
  );
  assert.deepEqual(result, { did, handle });
  assert.ok(!JSON.stringify(result).includes("access"));
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    did,
    handle,
    plcOp: operation,
  });
});
