import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
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
const serviceDid = "did:web:entryway.example.test";
/** A destination names itself in `did:web`, derived from its public endpoint. */
const destinationDid = (url) =>
  `did:web:${new URL(url).host.replaceAll(":", "%3A")}`;

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

const jwk = () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  return { ...privateKey.export({ format: "jwk" }), alg: "ES256K" };
};

test("stock reservation is unauthenticated, sends only the DID and never echoes binding facts", async () => {
  const reservationKey = (
    await Secp256k1Keypair.create({ exportable: true })
  ).did();
  const client = new ArrivalPdsClient({
    endpoint,
    did,
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
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

test("destination access tokens name the PDS as audience and keep the at+jwt type", async () => {
  const client = new ArrivalPdsClient({
    endpoint,
    did,
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
  });
  const { requests } = await serving(
    async () =>
      new Response(JSON.stringify({ activated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    () => client.checkAccountStatus(did),
  );
  assert.equal(requests.length, 1);
  const [scheme, token] = new Headers(requests[0].init.headers)
    .get("authorization")
    .split(" ");
  assert.equal(scheme, "Bearer");
  const header = decodeProtectedHeader(token);
  const claims = decodeJwt(token);
  // The destination's own access() verifier pins both of these.
  assert.equal(header.typ, "at+jwt");
  assert.equal(header.alg, "ES256K");
  assert.equal(claims.aud, destinationDid(endpoint));
  assert.notEqual(claims.aud, did);
  // The credential speaks for the account, never for the service taking it.
  assert.equal(claims.sub, did);
  assert.notEqual(claims.sub, destinationDid(endpoint));
  assert.equal(claims.iss, serviceDid);
  assert.equal(claims.exp - claims.iat, 60);
});

test("a stock reservation HTTP error, malformed body or unsupported key is refused", async () => {
  const client = new ArrivalPdsClient({
    endpoint,
    did,
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
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
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
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

test("deactivation is observed through the account's own status read", async () => {
  const client = new ArrivalPdsClient({
    endpoint,
    did,
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
  });
  let activated = true;
  await serving(
    async (url) => {
      if (url.pathname.endsWith("deactivateAccount")) {
        activated = false;
        return new Response("", { status: 200 });
      }
      return new Response(JSON.stringify({ activated }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => await client.deactivateAccount(did),
  );
  await serving(
    async () =>
      new Response(JSON.stringify({ activated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () =>
      await assert.rejects(client.deactivateAccount(did), {
        code: "AccountUnavailable",
      }),
  );
});
