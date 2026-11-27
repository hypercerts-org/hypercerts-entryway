import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  ControllerBindingVerifier,
  controllerBindingBytes,
  controllerDispatchKey,
  controllerFreezeFactsComplete,
  controllerDispatchDisposition,
  controllerQualificationResultSchema,
  controllerRouteRequestSchema,
  parseControllerJson,
  validateControllerLease,
} from "../../dist/src/pds/deployment-controller-contract.js";

const digest = `sha256:${"a".repeat(64)}`;
const nonce = "A".repeat(43);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const statement = {
  version: 1,
  issuer: "controller",
  keyId: "key-a",
  audience: "fleet",
  nonce,
  purpose: "describe-binding",
  controllerEpoch: "epoch-a",
  deploymentId: "deployment",
  hostId: "host",
  revision: 1,
  serviceDid: "did:web:host.example",
  publicEndpoint: "https://host.example/",
  routeId: "route",
  generation: 3,
  imageDigest: digest,
  configDigest: digest,
  launcherDigest: digest,
  incarnation: "process-a",
  observedAt: 1000,
  expiresAt: 2000,
};
const expected = Object.fromEntries(
  [
    "issuer",
    "audience",
    "nonce",
    "controllerEpoch",
    "deploymentId",
    "hostId",
    "revision",
    "serviceDid",
    "publicEndpoint",
  ].map((key) => [key, statement[key]]),
);
const signed = (value = statement, key = privateKey) =>
  JSON.stringify({
    ...value,
    signature: sign(null, controllerBindingBytes(value), key).toString(
      "base64url",
    ),
  });
const memoryConsumer = () => {
  const consumed = new Set();
  return async (binding) => {
    const key = JSON.stringify([
      binding.issuer,
      binding.audience,
      binding.controllerEpoch,
      binding.nonce,
    ]);
    if (consumed.has(key)) return false;
    consumed.add(key);
    return true;
  };
};
const verifier = (consume = memoryConsumer()) =>
  new ControllerBindingVerifier(
    new Map([["controller", new Map([["key-a", publicKey]])]]),
    consume,
  );
const request = {
  version: 1,
  authorityId: "fleet",
  callerId: "worker-a",
  controllerEpoch: "epoch-a",
  deploymentId: "deployment",
  hostId: "host",
  revision: 1,
  generation: 3,
  incarnation: "process-a",
  operationId: "operation",
  attemptId: "attempt",
  requestKey: "request",
  purpose: "staged-arrival",
  method: "com.atproto.server.createAccount",
  intentDigest: digest,
};
const lease = {
  ...request,
  capability: "B".repeat(43),
  issuedAt: 1000,
  expiresAt: 2000,
};

test("signed binding is exact, fresh, single use across workers and scoped to epoch", async () => {
  const consume = memoryConsumer();
  const first = verifier(consume);
  const second = verifier(consume);
  assert.equal(
    (await first.verify(signed(), expected, () => 1500)).hostId,
    "host",
  );
  await assert.rejects(
    second.verify(signed(), expected, () => 1500),
    {
      code: "ControllerChallengeReplayed",
    },
  );
  for (const changed of [
    { hostId: "other" },
    { deploymentId: "other" },
    { nonce: "C".repeat(43) },
    { controllerEpoch: "epoch-b" },
    { audience: "other" },
  ])
    await assert.rejects(
      verifier().verify(signed(), { ...expected, ...changed }, () => 1500),
      { code: "ControllerIdentityMismatch" },
    );
  await assert.rejects(
    verifier().verify(signed(), expected, () => 2000),
    {
      code: "ControllerExpired",
    },
  );
  await assert.rejects(
    verifier().verify(signed(), expected, () => 999),
    {
      code: "ControllerExpired",
    },
  );
  await assert.rejects(
    verifier().verify(
      signed({ ...statement, expiresAt: 32000 }),
      expected,
      () => 1500,
    ),
    { code: "ControllerExpired" },
  );
  await assert.rejects(
    verifier(async () => {
      throw Error("offline");
    }).verify(signed(), expected, () => 1500),
    { code: "ControllerUnavailable" },
  );
});

test("unknown, forged or retired controller signing keys fail closed", async () => {
  const other = generateKeyPairSync("ed25519");
  await assert.rejects(
    verifier().verify(
      signed(statement, other.privateKey),
      expected,
      () => 1500,
    ),
    { code: "ControllerIdentityMismatch" },
  );
  await assert.rejects(
    new ControllerBindingVerifier(
      new Map([["controller", new Map([["key-b", other.publicKey]])]]),
      memoryConsumer(),
    ).verify(signed(), expected, () => 1500),
    { code: "ControllerIdentityMismatch" },
  );
  const rotated = new ControllerBindingVerifier(
    new Map([
      [
        "controller",
        new Map([
          ["key-a", publicKey],
          ["key-b", other.publicKey],
        ]),
      ],
    ]),
    memoryConsumer(),
  );
  const replacement = { ...statement, keyId: "key-b", nonce: "C".repeat(43) };
  assert.equal(
    (
      await rotated.verify(
        signed(replacement, other.privateKey),
        { ...expected, nonce: replacement.nonce },
        () => 1500,
      )
    ).keyId,
    "key-b",
  );
});

test("bounded strict schemas reject unsupported data and do not expose it", async () => {
  assert.throws(() => parseControllerJson("x".repeat(65537)), {
    code: "ControllerInvalidResponse",
  });
  assert.throws(() => parseControllerJson("{"), {
    code: "ControllerInvalidResponse",
  });
  await assert.rejects(
    verifier().verify(
      JSON.stringify({
        ...JSON.parse(signed()),
        targetUrl: "https://untrusted.example",
      }),
      expected,
      () => 1500,
    ),
    { code: "ControllerInvalidResponse" },
  );
  assert.equal(
    controllerRouteRequestSchema.safeParse({
      ...request,
      method: "com.atproto.admin.deleteAccount",
    }).success,
    false,
  );
  assert.equal(
    controllerRouteRequestSchema.safeParse({
      ...request,
      targetUrl: "https://untrusted.example",
    }).success,
    false,
  );
});

test("lease binds every send fact and leaves enough time for admission", () => {
  assert.equal(
    validateControllerLease(lease, request, 1500, 500).hostId,
    "host",
  );
  for (const changed of [
    { callerId: "worker-b" },
    { hostId: "other" },
    { operationId: "other" },
    { attemptId: "other" },
    { generation: 4 },
    { controllerEpoch: "epoch-b" },
    { incarnation: "other" },
    { method: "com.atproto.repo.uploadBlob" },
    { intentDigest: `sha256:${"b".repeat(64)}` },
  ])
    assert.throws(
      () =>
        validateControllerLease(lease, { ...request, ...changed }, 1500, 500),
      { code: "ControllerIdentityMismatch" },
    );
  assert.throws(() => validateControllerLease(lease, request, 1501, 500), {
    code: "ControllerExpired",
  });
  assert.throws(() => validateControllerLease(lease, request, 2000, 0), {
    code: "ControllerExpired",
  });
  assert.throws(
    () =>
      validateControllerLease({ ...lease, expiresAt: 31001 }, request, 1500, 0),
    { code: "ControllerExpired" },
  );
  assert.equal(
    validateControllerLease({ ...lease, expiresAt: 31000 }, request, 1500, 0)
      .expiresAt,
    31000,
  );
});

test("dispatch deduplication identity survives worker credential rotation", () => {
  assert.equal(
    controllerDispatchKey(request),
    controllerDispatchKey({
      ...request,
      callerId: "worker-b",
      requestKey: "new-lease",
    }),
  );
  assert.notEqual(
    controllerDispatchKey(request),
    controllerDispatchKey({ ...request, authorityId: "other-fleet" }),
  );
  assert.notEqual(
    controllerDispatchKey(request),
    controllerDispatchKey({ ...request, attemptId: "recovery-attempt" }),
  );
});

test("delayed challenge commit cannot extend signed evidence", async () => {
  let now = 1500;
  const check = verifier(async () => {
    now = 2000;
    return true;
  });
  await assert.rejects(
    check.verify(signed(), expected, () => now),
    { code: "ControllerExpired" },
  );
});

test("freeze requires every isolation fact and no unresolved upstream work", () => {
  const status = {
    version: 1,
    deploymentId: "deployment",
    generation: 3,
    controllerEpoch: "epoch-a",
    admissionClosed: true,
    dispatchersIsolated: true,
    ingressDrained: true,
    unresolvedUpstream: 0,
  };
  assert.equal(controllerFreezeFactsComplete(status), true);
  for (const changed of [
    { admissionClosed: false },
    { dispatchersIsolated: false },
    { ingressDrained: false },
    { unresolvedUpstream: 1 },
  ])
    assert.equal(
      controllerFreezeFactsComplete({ ...status, ...changed }),
      false,
    );
  assert.throws(
    () => controllerFreezeFactsComplete({ ...status, version: 2 }),
    {
      code: "ControllerInvalidResponse",
    },
  );
  assert.equal(
    controllerQualificationResultSchema.safeParse({
      version: 1,
      runId: "run",
      runnerId: "runner",
      challengeCommitment: digest,
      testPlanVersion: "plan",
      cases: [
        {
          caseId: "one",
          project: "other",
          status: "passed",
          count: 1,
          artifactDigest: digest,
        },
      ],
    }).success,
    false,
  );
});

test("ambiguous dispatch stays held across a worker credential change", () => {
  const { callerId: _callerId, requestKey: _requestKey, ...binding } = request;
  for (const state of ["pending", "uncertain"]) {
    const receipt = { ...binding, state };
    assert.equal(
      controllerDispatchDisposition(receipt, {
        ...request,
        callerId: "worker-b",
      }),
      "hold",
    );
    assert.throws(
      () =>
        controllerDispatchDisposition(receipt, {
          ...request,
          attemptId: "new-attempt",
        }),
      { code: "ControllerIdentityMismatch" },
    );
  }
  assert.equal(
    controllerDispatchDisposition(
      { ...binding, state: "completed", resultDigest: digest },
      request,
    ),
    "completed",
  );
  assert.throws(
    () =>
      controllerDispatchDisposition(
        { ...binding, state: "completed" },
        request,
      ),
    { code: "ControllerInvalidResponse" },
  );
});

test("concurrent workers consume one issued challenge and never consume an invalid statement", async () => {
  let calls = 0;
  const store = memoryConsumer();
  const consume = async (...args) => {
    calls++;
    return store(...args);
  };
  const first = verifier(consume);
  const second = verifier(consume);
  const outcomes = await Promise.allSettled([
    first.verify(signed(), expected, () => 1500),
    second.verify(signed(), expected, () => 1500),
  ]);
  assert.equal(
    outcomes.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(
      (entry) =>
        entry.status === "rejected" &&
        entry.reason.code === "ControllerChallengeReplayed",
    ).length,
    1,
  );
  assert.equal(calls, 2);
  const tampered = { ...JSON.parse(signed()), generation: 4 };
  await assert.rejects(
    first.verify(JSON.stringify(tampered), expected, () => 1500),
    { code: "ControllerIdentityMismatch" },
  );
  assert.equal(calls, 2);
});

test("one trusted controller cannot sign as another trusted issuer", async () => {
  const other = generateKeyPairSync("ed25519");
  const keys = new Map([
    ["controller", new Map([["key-a", publicKey]])],
    ["controller-b", new Map([["key-a", other.publicKey]])],
  ]);
  const forged = { ...statement, issuer: "controller-b", keyId: "key-a" };
  await assert.rejects(
    new ControllerBindingVerifier(keys, memoryConsumer()).verify(
      signed(forged),
      { ...expected, issuer: "controller-b" },
      () => 1500,
    ),
    { code: "ControllerIdentityMismatch" },
  );
});
