import assert from "node:assert/strict";
import test from "node:test";
import { assertActivationReady } from "../../../dist/src/features/external-migration/activation-checks.js";

const key = (letter) => `did:key:z${letter.repeat(40)}`;
const approved = [key("a"), key("b")];
const recoveryKey = key("r");

const facts = (rotationKeys, arrival = {}) => ({
  arrival: {
    userId: "user",
    did: "did:plc:abc",
    email: "user@example.test",
    handle: "user.example.test",
    pdsId: "pds1",
    endpoint: "https://pds.example.test",
    signingKey: key("s"),
    approvedRotationKeys: approved,
    recoveryKey: null,
    ...arrival,
  },
  move: { cid: "bafymove" },
  directory: {
    sourcePlcHead: "bafymove",
    rotationKeys,
    source: {
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: "https://pds.example.test",
        },
      },
      verificationMethods: { atproto: key("s") },
      alsoKnownAs: ["at://user.example.test"],
    },
  },
  account: {
    status: "provisioning",
    email: "user@example.test",
    handle: "user.example.test",
    pdsId: "pds1",
    pdsUrl: "https://pds.example.test",
  },
  binding: { userId: "user" },
  configuredEndpoint: "https://pds.example.test",
  backend: {
    did: "did:plc:abc",
    handle: "user.example.test",
    deactivated: true,
  },
  activationJournaled: false,
});

const refused = (value) =>
  assert.throws(() => assertActivationReady(value), {
    code: "IdentityConflict",
  });

test("without a recovery key activation accepts exactly the approved list", () => {
  assertActivationReady(facts(approved));
  refused(facts([recoveryKey, ...approved]));
  refused(facts([...approved, recoveryKey]));
  refused(facts(approved.slice(0, 1)));
});

test("with a recovery key activation accepts exactly it first, then the approved list", () => {
  const arrival = { recoveryKey };
  assertActivationReady(facts([recoveryKey, ...approved], arrival));
  // Absent, misplaced, duplicated or any other foreign key is refused.
  refused(facts(approved, arrival));
  refused(facts([...approved, recoveryKey], arrival));
  refused(facts([recoveryKey, recoveryKey, ...approved], arrival));
  refused(facts([key("x"), ...approved], arrival));
  refused(facts([recoveryKey, ...approved, key("x")], arrival));
  refused(facts([recoveryKey, ...approved.slice(0, 1)], arrival));
});
