import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
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
import { summarizeArrival } from "../../dist/src/features/external-migration/arrival-summary.js";
import { createInvites } from "../../dist/src/features/account-registration/invites.mjs";
import {
  stagedRotationKeys,
  reapprovedSource,
  validateStagedMove,
} from "../../dist/src/plc/policy.js";

const create = "com.atproto.server.createAccount";

for (const scenario of ["interrupted", "acknowledged", "direct"]) {
  const direct = scenario === "direct";
  test(`staged arrival keeps the source canonical through transfer and validates ${scenario} cutover`, async (t) => {
    const f = await fixture(t, "modern", "distinct-handle");
    const target = f.config.pds[0];
    target.stagedIncomingMigration = true;
    let missing = true;
    let creates = 0;
    let failAfterActivation = false;
    const intercepted = [];
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
        intercepted.push(method);
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
        if (failAfterActivation && !f.backendState.deactivated) {
          failAfterActivation = false;
          throw new Error("destination unavailable");
        }
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
    assert.deepEqual(intercepted, []);
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
    f.setDirectoryFault("unavailable");
    await assert.rejects(ready, { code: "AccountUnavailable" });
    f.setDirectoryFault("");
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
      const dispatch = f.ownership.dispatch;
      let dispatchCount = 0;
      const race = t.mock.method(
        f.ownership,
        "dispatch",
        async (input, callbacks) => {
          if (input.step !== "incoming-cutover")
            return dispatch(input, callbacks);
          return dispatch(input, {
            ...callbacks,
            send: async () => {
              if (++dispatchCount === 1)
                throw new Error("interrupted before send");
              // Change the source after the second durable marker and before the send.
              f.audit.push({
                did: f.did,
                operation: updated,
                cid: updatedHead,
                nullified: false,
                createdAt: new Date().toISOString(),
              });
              race.mock.restore();
              // Exercise an actual acknowledged receipt with a null result, with
              // the source update visible when the caller observes the directory.
              return scenario === "acknowledged" ? null : callbacks.send();
            },
          });
        },
      );
      await assert.rejects(
        f.composed.submitIncomingHandoff(submission),
        /interrupted before send/,
      );
      const first = await f.store.pendingExternal(`arrival:${f.did}`);
      await f.store.approveRecovery({
        operationId: first.operationId,
        externalAttemptId: first.id,
        executionAttemptId: first.executionAttemptId,
        target: first.target,
        dispatcherIsolationReference: "case/first-isolation",
        upstreamDrainReference: "case/first-drain",
        action: "retry-if-safe",
      });
      await assert.rejects(f.composed.submitIncomingHandoff(submission), {
        code: "OperationRecoveryRequired",
      });
      const receipt = await f.store.pendingExternal(`arrival:${f.did}`);
      assert.equal(receipt.step, "incoming-cutover");
      if (scenario === "acknowledged") {
        assert.equal(receipt.state, "acknowledged");
        assert.equal(receipt.result, null);
        const row = (await f.db.read("external_operation_attempts")).find(
          (item) => item.id === receipt.id,
        );
        assert.equal(row.result, "null");
      }
      const blocked = await f.arrivals.readArrivalAccess(f.did);
      await assert.rejects(
        f.composed.reapproveArrival(f.request, "fresh-otp", {
          operationId: prepared.operationId,
          expectedVersion: blocked.version,
          expectedPlcHead: updatedHead,
        }),
        { code: "OperationRecoveryRequired" },
      );
      await f.store.approveRecovery({
        operationId: receipt.operationId,
        externalAttemptId: receipt.id,
        executionAttemptId: receipt.executionAttemptId,
        target: receipt.target,
        dispatcherIsolationReference: "case/isolation",
        upstreamDrainReference: "case/drain",
        action: "retry-if-safe",
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
      assert.equal(
        summarizeArrival(
          await f.arrivals.readArrivalAggregate(
            prepared.operationId,
            f.principal.userId,
          ),
        ).mayReapproveSource,
        true,
      );
      const predecessor = (await f.db.read("external_operation_attempts")).find(
        (item) => item.id === first.id,
      );
      assert.deepEqual(JSON.parse(predecessor.result), {
        recovery: "replay-safe",
      });
      const attemptsTable = f.db.tables.external_operation_attempts;
      await f.db.update(
        "external_operation_attempts",
        { intent_digest: "a".repeat(64) },
        eq(attemptsTable.id, first.id),
      );
      assert.equal(
        summarizeArrival(
          await f.arrivals.readArrivalAggregate(
            prepared.operationId,
            f.principal.userId,
          ),
        ).mayReapproveSource,
        false,
      );
      await f.db.update(
        "external_operation_attempts",
        { intent_digest: predecessor.intent_digest },
        eq(attemptsTable.id, first.id),
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
      const originalReceipt = (
        await f.db.read("external_operation_attempts")
      ).find((item) => item.id === receipt.id);
      for (const result of ["{}", "true", "not-json", '"null"']) {
        await f.db.update(
          "external_operation_attempts",
          { result },
          eq(attemptsTable.id, receipt.id),
        );
        assert.equal(
          summarizeArrival(
            await f.arrivals.readArrivalAggregate(
              prepared.operationId,
              f.principal.userId,
            ),
          ).mayReapproveSource,
          false,
        );
      }
      await f.db.update(
        "external_operation_attempts",
        { result: originalReceipt.result },
        eq(attemptsTable.id, receipt.id),
      );
      for (const recovery of [
        null,
        "[]",
        JSON.stringify([
          {
            ...JSON.parse(originalReceipt.recovery)[0],
            externalAttemptId: "wrong",
          },
        ]),
      ]) {
        await f.db.update(
          "external_operation_attempts",
          { recovery },
          eq(attemptsTable.id, receipt.id),
        );
        const summary = summarizeArrival(
          await f.arrivals.readArrivalAggregate(
            prepared.operationId,
            f.principal.userId,
          ),
        );
        assert.equal(summary.mayReapproveSource, false);
        if (recovery === null)
          await assert.rejects(
            f.composed.reapproveArrival(f.request, "fresh-otp", consent),
            { code: "OperationRecoveryRequired" },
          );
      }
      await f.db.update(
        "external_operation_attempts",
        { recovery: originalReceipt.recovery },
        eq(attemptsTable.id, receipt.id),
      );
      const approvedUpdate = await f.composed.reapproveArrival(
        f.request,
        "fresh-otp",
        consent,
      );
      const retired = (await f.db.read("external_operation_attempts")).find(
        (item) => item.id === receipt.id,
      );
      assert.equal(retired.state, "acknowledged");
      assert.deepEqual(JSON.parse(retired.result), {
        recovery: "superseded",
        intentDigest: retired.intent_digest,
      });
      assert.equal(
        JSON.parse(retired.recovery)[0].dispatcherIsolationReference,
        "case/isolation",
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
      await f.db.update(
        "external_operation_attempts",
        { recovery: null },
        eq(attemptsTable.id, receipt.id),
      );
      submission.presentation = await f.credential();
      await assert.rejects(f.composed.submitIncomingHandoff(submission), {
        code: "OperationRecoveryRequired",
      });
      await f.db.update(
        "external_operation_attempts",
        { recovery: retired.recovery },
        eq(attemptsTable.id, receipt.id),
      );
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
    const another = await f.composed.refreshArrivalSession(session.refreshJwt);
    failAfterActivation = true;
    await assert.rejects(ready(), { code: "AccountUnavailable" });
    assert.equal(f.backendState.activations, 1);
    const activated = await ready();
    assert.deepEqual(await ready(), activated);
    await assert.rejects(
      f.composed.activateArrivalWithCredential(session.refreshJwt),
    );
    await assert.rejects(
      f.composed.activateArrivalWithCredential(another.accessJwt),
    );
    await assert.rejects(f.composed.authorizeArrivalAccess(session.accessJwt));
    assert.equal(f.audit.length, direct ? 2 : 3);
    assert.equal(f.backendState.activations, 1);
    assert.equal((await f.storage.getByDid(f.did)).status, "active");
    assert.ok(
      (await f.arrivals.readArrivalFamilies(prepared.operationId)).every(
        (family) => family.revokedAt !== null,
      ),
    );
    await assert.rejects(f.composed.refreshArrivalSession(session.refreshJwt));
    t.mock.timers.enable({ apis: ["Date"] });
    t.mock.timers.tick(6 * 60 * 1000);
    await assert.rejects(ready());
    assert.equal(f.backendState.activations, 1);
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
  facts.alsoKnownAs.unshift("https://example.test/profile");
  facts.alsoKnownAs.push("at://secondary.example.test");
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
    alsoKnownAs: [
      `at://${handle}`,
      "https://example.test/profile",
      "at://secondary.example.test",
    ],
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
  const noHandle = await plc.signOperation(
    { ...facts, alsoKnownAs: ["https://example.test/profile"] },
    source,
  );
  await validateStagedMove({
    operation: await plc.signOperation(
      {
        ...moved,
        prev: String(await cidForCbor(noHandle)),
        alsoKnownAs: [`at://${handle}`, "https://example.test/profile"],
      },
      source,
    ),
    predecessor: noHandle,
    endpoint,
    handle,
    repositoryKey: entryway.did(),
    rotationKeys,
  });
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
