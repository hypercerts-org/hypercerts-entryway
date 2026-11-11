import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = new URL(
  "../support/helpers/incoming-arrival-restart.mjs",
  import.meta.url,
);
const cases = [
  "intent-response-missing",
  "key-response-lost",
  "signed-handoff",
  "handoff-observed",
  "creation-admitted",
  "saved-move",
  "creation-response-lost",
  "move-without-backend",
  "deactivation-lost",
  "deactivated-before-bind",
  "binding-response-lost",
  "lease-takeover",
];
const pendingCuts = new Set([
  "intent-response-missing",
  "key-response-lost",
  "signed-handoff",
  "handoff-observed",
  "move-without-backend",
  "divergent",
  "tombstone",
  "uncertain",
]);
function worker(directory, phase, cut, kill = false, observationDelay = 0) {
  return new Promise((resolve, reject) => {
    const child = fork(
      helper,
      [directory, phase, cut, String(observationDelay)],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let message;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`WorkerTimeout:${phase}:${cut}`));
    }, 20000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("message", (value) => {
      message = value;
      if (kill) {
        assert.equal(value.boundary, cut);
        child.kill("SIGKILL");
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if ((kill && signal !== "SIGKILL") || (!kill && code !== 0))
        return reject(
          new Error(
            `WorkerFailure:${phase}:${cut}:${code}:${signal}\n${stderr}`,
          ),
        );
      if (!message)
        return reject(new Error(`MissingWorkerEvidence:${phase}:${cut}`));
      resolve({ ...message, exit: code, signal });
    });
  });
}
for (const cut of [...cases, "divergent", "tombstone", "uncertain"]) {
  test(
    `fresh-process arrival reconciliation after ${cut}`,
    { timeout: 30000 },
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "incoming-restart-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const stopped = await worker(directory, "initial", cut, true);
      writeFileSync(
        join(directory, "stopped.json"),
        JSON.stringify({
          pid: stopped.pid,
          stopped: true,
          signal: stopped.signal,
          boundary: stopped.boundary,
        }),
        { mode: 0o600 },
      );
      const inspected = await worker(directory, "inspect", cut);
      const checkpoint = inspected.snapshot;
      assert.ok(checkpoint.aggregate);
      const aggregate = checkpoint.aggregate;
      if (cut === "intent-response-missing") {
        assert.ok(aggregate.reservation);
        assert.equal(aggregate.arrival.signingKey, null);
      } else
        assert.equal(
          aggregate.arrival.signingKey,
          JSON.parse(readFileSync(join(directory, "remote.json"))).repository,
        );
      if (["signed-handoff", "handoff-observed"].includes(cut)) {
        assert.equal(aggregate.signedOperations.length, 1);
        assert.equal(aggregate.admissions.length, 1);
        assert.equal(aggregate.progress.canonicalHandoffCid, null);
      }
      if (cut === "creation-admitted" || cut === "lease-takeover") {
        assert.equal(aggregate.admissions.length, 2);
        assert.equal(aggregate.signedOperations.length, 1);
      }
      if (
        [
          "saved-move",
          "creation-response-lost",
          "move-without-backend",
          "deactivation-lost",
          "deactivated-before-bind",
          "binding-response-lost",
        ].includes(cut)
      )
        assert.equal(aggregate.signedOperations.length, 2);
      if (cut === "saved-move") {
        assert.equal(checkpoint.counts.create, 0);
        assert.equal(checkpoint.external, null);
      }
      if (cut === "creation-response-lost") {
        assert.equal(aggregate.progress.provisionedAt, null);
        assert.equal(checkpoint.counts.create, 1);
        assert.ok(checkpoint.external);
      }
      if (cut === "deactivation-lost") {
        assert.ok(
          aggregate.attempts.some(
            (item) => item.reason === "settled:incoming-creation",
          ),
        );
        assert.ok(
          aggregate.attempts.some(
            (item) => item.reason === "external:incoming-pause",
          ),
        );
        assert.equal(aggregate.progress.provisionedAt, null);
        assert.equal(aggregate.progress.deactivatedAt, null);
      }
      if (cut === "deactivated-before-bind") {
        assert.ok(
          aggregate.attempts.some(
            (item) => item.reason === "settled:incoming-pause",
          ),
        );
        assert.equal(aggregate.progress.deactivatedAt, null);
        assert.equal(aggregate.progress.boundAt, null);
      }
      if (cut === "binding-response-lost") {
        assert.ok(aggregate.progress.boundAt);
        assert.equal(checkpoint.bindings.length, 1);
      }
      if (cut === "lease-takeover") {
        const crashedOwner = checkpoint.operations.find(
          (operation) => operation.id === checkpoint.claim.operationId,
        );
        assert.equal(crashedOwner.state, "running");
        assert.equal(crashedOwner.worker_id, checkpoint.claim.workerId);
        assert.equal(crashedOwner.fence, checkpoint.claim.fence);
      }
      // Regress the old 300 ms unrenewed lease under a controlled slow observation.
      const recovered = await worker(
        directory,
        "resume",
        cut,
        false,
        cut === "creation-response-lost" ? 400 : 0,
      );
      assert.notEqual(stopped.pid, recovered.pid);
      assert.notEqual(inspected.pid, recovered.pid);
      const after = recovered.snapshot;
      const expectedErrors = {
        divergent: "OperationRecoveryRequired",
        "move-without-backend": "OperationRecoveryRequired",
        tombstone: "InvalidCustodyObservation",
        uncertain: "FixtureObservationUnavailable",
      };
      if (expectedErrors[cut])
        assert.equal(recovered.outcome.code, expectedErrors[cut]);
      else {
        assert.equal(recovered.outcome.state, "pending");
        assert.equal(recovered.outcome.code, undefined);
      }
      assert.equal(
        recovered.gated,
        Boolean(checkpoint.external) && cut !== "move-without-backend",
      );
      if (cut === "move-without-backend") {
        assert.deepEqual(after.external, checkpoint.external);
        assert.equal(after.external.state, "dispatched");
        assert.equal(after.external.recovery, null);
      }
      if (recovered.gated) {
        assert.equal(recovered.gateEvidence.code, "OperationRecoveryRequired");
        assert.equal(recovered.gateEvidence.unresolvedState, "dispatched");
        assert.equal(recovered.gateEvidence.unchangedBeforeApproval, true);
        assert.equal(recovered.gateEvidence.killedPid, stopped.pid);
        assert.equal(recovered.gateEvidence.signal, "SIGKILL");
        assert.equal(recovered.gateEvidence.approvedState, "recovery-approved");
        if (cut !== "move-without-backend") assert.equal(after.external, null);
      }
      const inviteCounts = {
        reserved: after.invites.length,
        completed: after.invites.reduce(
          (total, entry) => total + entry.value.uses.length,
          0,
        ),
        remaining: after.invites.reduce(
          (total, entry) => total + entry.value.remaining,
          0,
        ),
      };
      assert.equal(
        inviteCounts.reserved,
        aggregate.admissions.length === 2 ? 1 : 0,
      );
      assert.equal(inviteCounts.completed, pendingCuts.has(cut) ? 0 : 1);
      assert.equal(inviteCounts.remaining, 0);
      assert.equal(after.counts.reserve, 1);
      assert.equal(after.counts.credentials, checkpoint.counts.credentials);
      for (const signed of aggregate.signedOperations)
        assert.deepEqual(
          after.aggregate.signedOperations.find(
            (item) => item.kind === signed.kind,
          ),
          signed,
        );
      assert.deepEqual(after.aggregate.admissions, aggregate.admissions);
      if (pendingCuts.has(cut)) {
        assert.equal(after.aggregate.progress.boundAt, null);
        assert.equal(after.bindings.length, 0);
        assert.equal(after.counts.create, checkpoint.counts.create);
        assert.equal(after.counts.pause, checkpoint.counts.pause);
        assert.equal(after.counts.sign, checkpoint.counts.sign);
        if (cut !== "signed-handoff")
          assert.equal(after.counts.handoff, checkpoint.counts.handoff);
        if (cut === "signed-handoff") {
          assert.equal(after.head, aggregate.signedOperations[0].cid);
          assert.equal(after.counts.handoff, 1);
        } else assert.equal(after.head, checkpoint.head);
        assert.equal(after.currentKey, checkpoint.currentKey);
        assert.deepEqual(after.invites, checkpoint.invites);
      } else {
        assert.equal(recovered.outcome.state, "pending");
        assert.ok(after.aggregate.progress.provisionedAt);
        assert.ok(after.aggregate.progress.deactivatedAt);
        assert.ok(after.aggregate.progress.boundAt);
        assert.equal(after.bindings.length, 1);
        assert.equal(after.counts.create, 1);
        assert.equal(after.counts.pause, 1);
        assert.equal(after.counts.sign, 1);
        assert.equal(after.counts.handoff, 1);
        const remote = JSON.parse(readFileSync(join(directory, "remote.json")));
        assert.equal(remote.moves.length, 1);
        const move = after.aggregate.signedOperations.find(
          (item) => item.kind === "destination-move",
        );
        assert.equal(remote.moves[0], JSON.stringify(move.operation));
        assert.equal(after.currentKey, remote.repository);
        // A further new process consumes the committed binding without effects.
        const repeat = await worker(directory, "resume", cut);
        assert.deepEqual(repeat.snapshot.counts, after.counts);
        assert.deepEqual(repeat.snapshot.invites, after.invites);
        assert.equal(
          repeat.snapshot.aggregate.progress.boundAt,
          after.aggregate.progress.boundAt,
        );
      }
      t.diagnostic(
        JSON.stringify({
          cut,
          initialPid: stopped.pid,
          inspectPid: inspected.pid,
          recoveryPid: recovered.pid,
          signal: stopped.signal,
          outcome: recovered.outcome,
          counts: after.counts,
          inviteCounts,
          gated: recovered.gated,
          gateEvidence: recovered.gateEvidence,
          bound: after.bindings.length,
        }),
      );
    },
  );
}
for (const [phase, cut, marker] of [
  ["resume-unexpected", "uncertain", "UnexpectedObservationFailure"],
  ["resume-unexpected-coded", "uncertain", "UnexpectedCodedObservationFailure"],
  [
    "resume-unexpected-gate",
    "handoff-observed",
    "UnexpectedPreapprovalFailure",
  ],
  ["resume-spoofed-gate", "handoff-observed", "error instanceof DomainError"],
]) {
  test(`unexpected exception fails the recovery worker: ${phase}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "incoming-restart-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const stopped = await worker(directory, "initial", cut, true);
    writeFileSync(
      join(directory, "stopped.json"),
      JSON.stringify({
        pid: stopped.pid,
        stopped: true,
        signal: stopped.signal,
        boundary: stopped.boundary,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(worker(directory, phase, cut), (error) => {
      assert.match(
        error.message,
        new RegExp(`WorkerFailure:${phase}:${cut}:1:null`),
      );
      assert.ok(error.message.includes(marker), error.message);
      return true;
    });
    t.diagnostic(
      JSON.stringify({
        phase,
        cut,
        signal: stopped.signal,
        rejectedWorkerExit: 1,
        marker,
      }),
    );
  });
}
test("actor appearing during move signing stays pending before create, pause or bind", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "incoming-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await worker(directory, "initial", "actor-during-sign");
  assert.equal(result.outcome.code, "OperationRecoveryRequired");
  assert.equal(result.snapshot.counts.sign, 1);
  assert.equal(result.snapshot.counts.create, 0);
  assert.equal(result.snapshot.counts.pause, 0);
  assert.equal(result.snapshot.bindings.length, 0);
  assert.equal(result.snapshot.aggregate.progress.provisionedAt, null);
  assert.equal(result.snapshot.aggregate.signedOperations.length, 2);
});
