// Controller-local AiaB state. This module does not authenticate callers or grant leases.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  controllerBindingSchema,
  controllerRouteRequestSchema,
} from "../../dist/src/pds/deployment-controller-contract.js";
import { z } from "zod";

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function immutable(request) {
  return JSON.stringify([
    request.authorityId,
    request.deploymentId,
    request.hostId,
    request.revision,
    request.generation,
    request.incarnation,
    request.purpose,
    request.method,
    request.intentDigest,
  ]);
}
const boundDeploymentSchema = controllerBindingSchema
  .pick({
    deploymentId: true,
    hostId: true,
    revision: true,
    incarnation: true,
    serviceDid: true,
    publicEndpoint: true,
    routeId: true,
    imageDigest: true,
    configDigest: true,
    launcherDigest: true,
  })
  .extend({ manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) });
function bindingIdentity(value) {
  const binding = boundDeploymentSchema.parse(value);
  return JSON.stringify([
    binding.deploymentId,
    binding.hostId,
    binding.revision,
    binding.incarnation,
    binding.serviceDid,
    binding.publicEndpoint,
    binding.routeId,
    binding.imageDigest,
    binding.configDigest,
    binding.launcherDigest,
    binding.manifestDigest,
  ]);
}
export function openControllerGate(path, options = {}) {
  const db = new DatabaseSync(path, { timeout: 10_000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS controller_state (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, epoch TEXT NOT NULL, binding TEXT NOT NULL, frozen INTEGER NOT NULL, recovery INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dispatch_attempts (authority TEXT NOT NULL, operation TEXT NOT NULL, attempt TEXT NOT NULL, immutable TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','uncertain','completed')), result_digest TEXT, PRIMARY KEY(authority,operation,attempt));`);
  const state = () =>
    db.prepare("SELECT * FROM controller_state WHERE id=1").get();
  const lookup = (request) =>
    db
      .prepare(
        "SELECT * FROM dispatch_attempts WHERE authority=? AND operation=? AND attempt=?",
      )
      .get(request.authorityId, request.operationId, request.attemptId);
  if (options.binding) {
    try {
      const identity = bindingIdentity(options.binding);
      transaction(db, () => {
        const old = state();
        const unresolved = db
          .prepare(
            "SELECT 1 FROM dispatch_attempts WHERE state != 'completed' LIMIT 1",
          )
          .get();
        if (
          old &&
          old.binding !== identity &&
          (old.frozen || old.recovery || unresolved)
        )
          throw Error("ControllerIsolationRequired");
        const generation = old
          ? old.generation + Number(old.binding !== identity)
          : 1;
        if (!Number.isSafeInteger(generation))
          throw Error("ControllerGenerationExhausted");
        const recovery = Boolean(old?.recovery || unresolved);
        db.prepare(
          "UPDATE dispatch_attempts SET state='uncertain' WHERE state='pending'",
        ).run();
        db.prepare(
          "INSERT INTO controller_state(id,generation,epoch,binding,frozen,recovery) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,epoch=excluded.epoch,binding=excluded.binding,frozen=excluded.frozen,recovery=excluded.recovery",
        ).run(
          generation,
          randomUUID(),
          identity,
          Number(Boolean(old?.frozen)),
          Number(recovery),
        );
      });
    } catch (error) {
      db.close();
      throw error;
    }
  }
  return {
    snapshot() {
      const current = state();
      if (!current) throw Error("ControllerNotStarted");
      return {
        generation: current.generation,
        epoch: current.epoch,
        frozen: Boolean(current.frozen),
        recoveryRequired: Boolean(current.recovery),
      };
    },
    // The caller must authenticate the caller and validate a live, incarnation-bound lease before invoking this method.
    admit(value) {
      const request = controllerRouteRequestSchema.parse(value);
      return transaction(db, () => {
        const prior = lookup(request);
        if (prior) {
          if (prior.immutable !== immutable(request))
            throw Error("ControllerAttemptConflict");
          return prior.state === "completed"
            ? { state: "completed", resultDigest: prior.result_digest }
            : { state: "hold" };
        }
        const unresolved = db
          .prepare(
            "SELECT 1 FROM dispatch_attempts WHERE authority=? AND operation=? AND (state != 'completed' OR immutable=?) LIMIT 1",
          )
          .get(request.authorityId, request.operationId, immutable(request));
        if (unresolved) return { state: "hold" };
        const current = state();
        if (!current || current.frozen || current.recovery)
          throw Error("ControllerAdmissionClosed");
        const [deployment, host, revision, incarnation] = JSON.parse(
          current.binding,
        );
        if (
          request.controllerEpoch !== current.epoch ||
          request.generation !== current.generation ||
          request.deploymentId !== deployment ||
          request.hostId !== host ||
          request.revision !== revision ||
          request.incarnation !== incarnation
        )
          throw Error("ControllerBindingChanged");
        db.prepare(
          "INSERT INTO dispatch_attempts(authority,operation,attempt,immutable,state) VALUES(?,?,?,?, 'pending')",
        ).run(
          request.authorityId,
          request.operationId,
          request.attemptId,
          immutable(request),
        );
        return { state: "admitted" };
      });
    },
    uncertain(value) {
      const request = controllerRouteRequestSchema.parse(value);
      return transaction(db, () => {
        const prior = lookup(request);
        if (!prior || prior.immutable !== immutable(request))
          throw Error("ControllerAttemptConflict");
        if (prior.state === "pending")
          db.prepare(
            "UPDATE dispatch_attempts SET state='uncertain' WHERE authority=? AND operation=? AND attempt=? AND state='pending'",
          ).run(request.authorityId, request.operationId, request.attemptId);
      });
    },
    complete(value, resultDigest) {
      const request = controllerRouteRequestSchema.parse(value);
      if (!/^sha256:[a-f0-9]{64}$/.test(resultDigest))
        throw Error("InvalidControllerResult");
      return transaction(db, () => {
        const prior = lookup(request);
        if (!prior || prior.immutable !== immutable(request))
          throw Error("ControllerAttemptConflict");
        if (prior.state === "completed") {
          if (prior.result_digest !== resultDigest)
            throw Error("ControllerResultConflict");
          return;
        }
        if (prior.state !== "pending")
          throw Error("ControllerRecoveryRequired");
        db.prepare(
          "UPDATE dispatch_attempts SET state='completed',result_digest=? WHERE authority=? AND operation=? AND attempt=? AND state='pending'",
        ).run(
          resultDigest,
          request.authorityId,
          request.operationId,
          request.attemptId,
        );
      });
    },
    freeze(expectedGeneration, expectedEpoch) {
      transaction(db, () => {
        const changed = db
          .prepare(
            "UPDATE controller_state SET frozen=1 WHERE id=1 AND generation=? AND epoch=?",
          )
          .run(expectedGeneration, expectedEpoch);
        if (changed.changes !== 1) throw Error("ControllerBindingChanged");
      });
    },
    close() {
      db.close();
    },
  };
}
