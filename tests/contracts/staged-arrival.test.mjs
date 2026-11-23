import assert from "node:assert/strict";
import test from "node:test";
import { cidForCbor } from "@atproto/common";
import { Secp256k1Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import { Secp256k1MigrationPlcSigner } from "../../dist/src/plc/signing.js";
import { importJWK, jwtVerify } from "jose";
import {
  fixture,
  handle,
  endpoint,
} from "../support/helpers/incoming-arrival-fixture.mjs";
import { createInvites } from "../../dist/src/features/account-registration/invites.mjs";
import {
  stagedRotationKeys,
  reapprovedSource,
  validateStagedMove,
} from "../../dist/src/plc/policy.js";

const create = "com.atproto.server.createAccount";

for (const direct of [false, true]) {
  test(`staged arrival keeps the source canonical through transfer and validates ${direct ? "a client-published" : "an Entryway-submitted"} cutover`, async (t) => {
    const f = await fixture(t, "modern", "distinct-handle");
    const target = f.config.pds[0];
    target.stagedIncomingMigration = true;
    let missing = true;
    let creates = 0;
    const ordinaryFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const request = new URL(url);
      const method = request.pathname.split("/").at(-1);
      if (
        [
          create,
          "com.atproto.admin.updateSubjectStatus",
          "com.atproto.server.reserveSigningKey",
        ].includes(method)
      ) {
        const jwt = await jwtVerify(
          options.headers.authorization.slice(7),
          await importJWK(f.config.jwtJwk, "ES256K"),
          {
            issuer: f.config.serviceDid,
            audience: target.did,
            algorithms: ["ES256K"],
            typ: "JWT",
          },
        );
        assert.equal(jwt.payload.lxm, method);
        if (method === "com.atproto.server.reserveSigningKey") {
          assert.deepEqual(JSON.parse(options.body), { did: f.did });
          return Response.json({ signingKey: f.repository.did() });
        }
        if (method === "com.atproto.admin.updateSubjectStatus") {
          assert.equal(JSON.parse(options.body).deactivated.applied, false);
          f.backendState.activations++;
          f.backendState.deactivated = false;
          return Response.json({});
        }
        assert.deepEqual(JSON.parse(options.body), { did: f.did, handle });
        assert.equal(f.audit.length, 1);
        creates++;
        f.backendState.exists = true;
        f.backendState.deactivated = true;
        return Response.json({
          did: f.did,
          handle,
          accessJwt: "discarded",
          refreshJwt: "discarded",
        });
      }
      if (method === "com.atproto.repo.listMissingBlobs") {
        assert.equal(request.searchParams.get("limit"), "1");
        return Response.json({ blobs: missing ? [{ cid: "missing" }] : [] });
      }
      if (method === "com.atproto.server.checkAccountStatus")
        return Response.json({
          activated: !f.backendState.deactivated,
          validDid:
            f.audit.at(-1).operation.services.atproto_pds.endpoint === endpoint,
        });
      if (method === "com.atproto.identity.getRecommendedDidCredentials")
        return Response.json({
          verificationMethods: { atproto: f.repository.did() },
        });
      return ordinaryFetch(url, options);
    };
    const userKey = (await Secp256k1Keypair.create()).did();
    const prepared = await f.composed.prepareArrival(f.request, "fresh-otp", {
      did: f.did,
      handle,
      ...(direct ? {} : { retireRotationKeys: f.predecessor.rotationKeys }),
    });
    assert.equal(prepared.migrationMode, "staged");
    assert.equal(prepared.handoff, undefined);
    const approved = direct
      ? [...f.predecessor.rotationKeys, f.hot.did()]
      : [f.hot.did()];
    assert.deepEqual(prepared.approvedRotationKeys, approved);
    const invitation = await createInvites({
      db: f.db,
      config: f.config,
      accounts: { get: async () => null },
    });
    const { code } = await invitation.createInviteCode({ useCount: 1 });
    const createInput = {
      arrivalCode: prepared.arrivalCode,
      presentation: await f.credential(create),
      body: { did: f.did, handle, inviteCode: code, recoveryKey: userKey },
    };
    await assert.rejects(
      f.composed.createIncomingAccount({
        ...createInput,
        presentation: await f.credential(),
      }),
    );
    assert.equal(await f.arrivals.readArrivalAccess(f.did), null);
    target.stagedIncomingMigration = false;
    await assert.rejects(f.composed.createIncomingAccount(createInput), {
      code: "OperationConflict",
    });
    assert.equal(await f.arrivals.readArrivalAccess(f.did), null);
    assert.equal(
      (
        await f.arrivals.readArrivalAggregate(
          prepared.operationId,
          f.principal.userId,
        )
      ).reservation,
      null,
    );
    assert.deepEqual(f.backendState.calls, []);
    target.stagedIncomingMigration = true;
    if (!direct) {
      const retiredKey = f.predecessor.rotationKeys[0];
      await assert.rejects(
        f.composed.createIncomingAccount({
          ...createInput,
          body: { ...createInput.body, recoveryKey: retiredKey },
        }),
        { error: "InvalidRequest" },
      );
      // Independently exercise the transaction's defense against a retired key.
      const record = f.arrivals.recordArrivalReplay;
      const entry = t.mock.method(
        f.arrivals,
        "recordArrivalReplay",
        async (owner, version, facts, proof, options) => {
          await assert.rejects(
            record(owner, version, facts, proof, { recoveryKey: retiredKey }),
            { code: "InvalidAccount" },
          );
          entry.mock.restore();
          return record(owner, version, facts, proof, options);
        },
      );
    }
    const session = await f.composed.createIncomingAccount(createInput);
    assert.equal(session.active, false);
    assert.equal(creates, 1);
    assert.equal(f.audit.length, 1);
    assert.equal(f.backendState.pauses, 0);
    assert.equal((await f.arrivals.readArrivalAccess(f.did)).bound, true);
    const final = await plc.signOperation(
      plc.formatAtprotoOp({
        signingKey: f.repository.did(),
        handle,
        pds: endpoint,
        rotationKeys: [userKey, ...approved],
        prev: f.head,
      }),
      f.source,
    );
    const ready = () =>
      f.composed.activateArrivalWithCredential(session.accessJwt);
    await assert.rejects(ready, { code: "IdentityConflict" });
    const submission = {
      arrivalCode: prepared.arrivalCode,
      presentation: await f.credential(),
      body: { operation: final },
    };
    await assert.rejects(f.composed.submitIncomingHandoff(submission), {
      code: "OperationConflict",
    });
    assert.equal(f.audit.length, 1);
    assert.equal(f.publicationAttempts.length, 0);
    if (direct) {
      f.audit.push({
        did: f.did,
        cid: String(await cidForCbor(final)),
        operation: final,
        nullified: false,
        createdAt: new Date().toISOString(),
      });
      const changedSigner = t.mock.method(
        Secp256k1MigrationPlcSigner.prototype,
        "publicKey",
        () => userKey,
      );
      await assert.rejects(ready(), /Restore the approved Entryway/);
      assert.equal(f.backendState.activations, 0);
      assert.equal(
        (
          await f.arrivals.readArrivalAggregate(
            prepared.operationId,
            f.principal.userId,
          )
        ).signedOperations.length,
        0,
      );
      changedSigner.mock.restore();
      await assert.rejects(ready, { code: "OperationConflict" });
      missing = false;
    } else {
      missing = false;
      const { sig: _sourceSignature, ...sourceFacts } = f.predecessor;
      const { sig: _oldSignature, ...moveFacts } = final;
      const updated = await plc.signOperation(
        {
          ...sourceFacts,
          alsoKnownAs: ["at://updated.example.test"],
          prev: f.head,
        },
        f.source,
      );
      const updatedHead = String(await cidForCbor(updated));
      const recordSigned = f.arrivals.recordSignedOperation;
      const race = t.mock.method(
        f.arrivals,
        "recordSignedOperation",
        async (...args) => {
          const saved = await recordSigned(...args);
          // The source advances after signed admission and before any PLC dispatch marker.
          f.audit.push({
            did: f.did,
            operation: updated,
            cid: updatedHead,
            nullified: false,
            createdAt: new Date().toISOString(),
          });
          race.mock.restore();
          return saved;
        },
      );
      await assert.rejects(f.composed.submitIncomingHandoff(submission), {
        code: "IdentityConflict",
      });
      assert.equal(
        (
          await f.arrivals.readArrivalAggregate(
            prepared.operationId,
            f.principal.userId,
          )
        ).signedOperations.length,
        1,
      );
      assert.equal(f.publicationAttempts.length, 0);
      const status = await f.arrivals.readArrivalAccess(f.did);
      const consent = {
        operationId: prepared.operationId,
        expectedVersion: status.version,
        expectedPlcHead: updatedHead,
      };
      await assert.rejects(
        f.composed.reapproveArrival(f.request, "wrong", consent),
        { error: "ArrivalProofRequired" },
      );
      await assert.rejects(
        f.composed.reapproveArrival(f.request, "fresh-otp", {
          ...consent,
          expectedPlcHead: f.head,
        }),
        { code: "IdentityConflict" },
      );
      const approvedUpdate = await f.composed.reapproveArrival(
        f.request,
        "fresh-otp",
        consent,
      );
      assert.equal(approvedUpdate.expectedPlcHead, updatedHead);
      assert.deepEqual(approvedUpdate.approvedRotationKeys, [
        userKey,
        ...approved,
      ]);
      assert.equal(approvedUpdate.version, status.version + 1);
      await assert.rejects(
        f.composed.createIncomingAccount(createInput),
        /Credentials were already issued/,
      );
      assert.equal(creates, 1);
      submission.body.operation = await plc.signOperation(
        { ...moveFacts, prev: updatedHead },
        f.source,
      );
      await assert.rejects(f.composed.submitIncomingHandoff(submission), {
        code: "OperationConflict",
      });
      submission.presentation = await f.credential();
      const changedSigner = t.mock.method(
        Secp256k1MigrationPlcSigner.prototype,
        "publicKey",
        () => userKey,
      );
      await assert.rejects(
        f.composed.submitIncomingHandoff(submission),
        /Restore the approved Entryway/,
      );
      assert.equal(f.publicationAttempts.length, 0);
      changedSigner.mock.restore();
      // The saved mode governs this arrival even if the operator changes placement capability.
      target.stagedIncomingMigration = false;
      await f.composed.submitIncomingHandoff(submission);
      await f.composed.submitIncomingHandoff(submission);
      assert.equal(f.publicationAttempts.length, 1);
    }
    await ready();
    assert.equal(f.audit.length, direct ? 2 : 3);
    assert.equal(f.backendState.activations, 1);
    assert.equal((await f.storage.getByDid(f.did)).status, "active");
    assert.ok(
      (await f.arrivals.readArrivalFamilies(prepared.operationId)).every(
        (family) => family.revokedAt !== null,
      ),
    );
    await assert.rejects(f.composed.refreshArrivalSession(session.refreshJwt));
  });
}

test("staged custody retains non-ATProto services, methods and aliases and rejects unapproved removals", async () => {
  const source = await Secp256k1Keypair.create();
  const entryway = await Secp256k1Keypair.create();
  const rotationKeys = [source.did(), entryway.did()];
  for (const remove of [
    [source.did(), source.did()],
    [entryway.did()],
    ["did:key:unknown"],
  ])
    assert.throws(() =>
      stagedRotationKeys([source.did()], entryway.did(), remove),
    );
  const facts = plc.formatAtprotoOp({
    signingKey: source.did(),
    handle,
    pds: "https://source.example.test",
    rotationKeys: [source.did()],
    prev: null,
  });
  facts.services.extra = {
    type: "Other",
    endpoint: "https://other.example.test",
  };
  facts.verificationMethods.other = source.did();
  facts.alsoKnownAs.push("https://example.test/profile");
  const predecessor = await plc.signOperation(facts, source);
  for (const edit of [
    {
      services: {
        ...facts.services,
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: "https://different.example.test",
        },
      },
    },
    {
      verificationMethods: {
        ...facts.verificationMethods,
        atproto: entryway.did(),
      },
    },
    { rotationKeys },
  ]) {
    const intermediate = await plc.signOperation(
      { ...facts, ...edit, prev: String(await cidForCbor(predecessor)) },
      source,
    );
    const restored = await plc.signOperation(
      { ...facts, prev: String(await cidForCbor(intermediate)) },
      source,
    );
    await assert.rejects(
      reapprovedSource(
        predecessor,
        [intermediate, restored],
        String(await cidForCbor(restored)),
      ),
    );
  }
  const ordered = await plc.signOperation({ ...facts, rotationKeys }, source);
  const siblingFacts = {
    ...facts,
    rotationKeys,
    prev: String(await cidForCbor(ordered)),
  };
  const normal = await plc.signOperation(siblingFacts, entryway);
  const powerful = await plc.signOperation(siblingFacts, source);
  await assert.rejects(
    reapprovedSource(
      ordered,
      [normal],
      String(await cidForCbor(normal)),
      powerful,
    ),
  );
  await reapprovedSource(
    ordered,
    [powerful],
    String(await cidForCbor(powerful)),
    normal,
  );
  const moved = {
    ...facts,
    prev: String(await cidForCbor(predecessor)),
    rotationKeys,
    services: {
      ...facts.services,
      atproto_pds: { type: "AtprotoPersonalDataServer", endpoint },
    },
    verificationMethods: {
      ...facts.verificationMethods,
      atproto: entryway.did(),
    },
  };
  const validate = async (changes, signer = source) =>
    validateStagedMove({
      operation: await plc.signOperation({ ...moved, ...changes }, signer),
      predecessor,
      endpoint,
      handle,
      repositoryKey: entryway.did(),
      rotationKeys,
    });
  await validate({});
  for (const mutation of [
    { rotationKeys: [entryway.did()] },
    { services: { atproto_pds: moved.services.atproto_pds } },
    { verificationMethods: { atproto: entryway.did() } },
    { alsoKnownAs: [`at://${handle}`] },
    { prev: null },
  ])
    await assert.rejects(validate(mutation));
  await assert.rejects(validate({}, entryway));
});
