import { xrpc } from "../../dist/src/pds/client.mjs";
import { rejectedPlcSubmission } from "../../dist/src/pds/xrpc-response.js";
import { noExternalResult } from "../../dist/src/accounts/operation-ownership.js";
import { createAccounts } from "../../dist/src/compose-accounts.mjs";
import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";
import { pauseVerificationConsumption } from "./verification-barrier.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { createMailOutbox } from "../../dist/src/database/drizzle/mail-outbox.js";
import { query } from "../support/database-inspection.mjs";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createAccountAuthority } from "../../dist/src/database/drizzle/account-authority.mjs";
import { createSecurityPrimitives } from "../../dist/src/accounts/security-primitives.mjs";
import { createMailFeature } from "../../dist/src/mail/delivery.js";
import { createBetterAuthAuthentication } from "../../dist/src/authentication/better-auth.mjs";
let db,
  ownership,
  mail,
  proofs,
  accounts,
  authentication,
  releaseHeld,
  releaseConsumed,
  accountOperations,
  interruptAccountAcknowledgement = false,
  releaseScheduler,
  plcCoordinator,
  releaseRejection;
process.on("message", async ({ id, command, args }) => {
  try {
    let result;
    switch (command) {
      case "open":
        db = await openDatabase(args);
        ownership = createOperationOwnershipStore(db);
        mail = createMailOutbox(db);
        result = {
          processId: process.pid,
          backendId: (
            await query(db, "SELECT pg_backend_pid() AS id", [], "get")
          ).id,
        };
        break;
      case "plcOpen": {
        const store = {
          ...ownership,
          async rejectPlcSubmission(...parameters) {
            const pause = async () => {
              process.send({
                event: "plc-rejection-held",
                phase: args.pause,
                processId: process.pid,
              });
              await new Promise((resolve) => {
                releaseRejection = resolve;
              });
            };
            if (args.pause === "before-commit")
              return db.transact(async () => {
                await ownership.rejectPlcSubmission(...parameters);
                await pause();
              });
            await ownership.rejectPlcSubmission(...parameters);
            if (args.pause === "after-commit") await pause();
          },
        };
        plcCoordinator = createOperationOwnership({
          store,
          workerId: `plc-process-${process.pid}`,
          leaseMs: args.leaseMs,
          heartbeatMs: 0,
        });
        break;
      }
      case "plcSubmit": {
        const method = "com.atproto.identity.submitPlcOperation";
        result = await plcCoordinator.run(
          args.did,
          { kind: "plc-submit", request: args.intent, completeOnReturn: true },
          () =>
            plcCoordinator.dispatchPlcSubmission(
              { target: args.target, intent: args.intent },
              {
                ...noExternalResult,
                send: () => xrpc(args.target, method, args.intent),
                observe: async () => ({ state: "diverged" }),
                rejection: (error) =>
                  rejectedPlcSubmission(
                    error,
                    args.target,
                    args.intent.operation,
                  ),
              },
            ),
        );
        break;
      }
      case "releaseRejection":
        releaseRejection();
        break;
      case "accountOperationsOpen": {
        let marked = false;
        const accountStore = {
          ...ownership,
          async acknowledgeExternal(claim, attempt, result) {
            await ownership.acknowledgeExternal(claim, attempt, result);
            if (interruptAccountAcknowledgement) {
              interruptAccountAcknowledgement = false;
              throw Object.assign(
                new Error("Controlled interruption after acknowledgement"),
                { code: "FixtureInterrupted" },
              );
            }
          },
        };
        const store = args.pausePreflight
          ? {
              ...accountStore,
              async beginExternal(...parameters) {
                const attempt = await ownership.beginExternal(...parameters);
                marked = true;
                return attempt;
              },
              async assertActive(claim) {
                await ownership.assertActive(claim);
                if (marked) {
                  marked = false;
                  process.send({
                    event: "external-preflight-paused",
                    processId: process.pid,
                  });
                  await new Promise((resolve) => {
                    releaseHeld = resolve;
                  });
                }
              },
            }
          : accountStore;
        const coordinator = createOperationOwnership({
          store,
          workerId: `account-process-${process.pid}`,
          leaseMs: args.leaseMs,
          heartbeatMs: 0,
        });
        accountOperations = await createAccounts({
          db,
          config: args.config,
          ownership: coordinator,
        });
        break;
      }
      case "accountStatus":
        result = {
          status: (
            await accountOperations.setStatus(args.did, args.status, {
              deleteAfter: args.deleteAfter,
            })
          ).status,
        };
        break;
      case "accountInterruptAcknowledgement":
        interruptAccountAcknowledgement = true;
        break;
      case "accountReconcile": {
        const object =
          args.pause === "operations" ? db : accountOperations.storage;
        const method = args.pause === "operations" ? "list" : "listAccounts";
        const original = object[method].bind(object);
        let paused = false;
        object[method] = async (...parameters) => {
          const rows = await original(...parameters);
          if (
            !paused &&
            (args.pause !== "operations" || parameters[0] === "operations")
          ) {
            paused = true;
            process.send({
              event: "scheduler-snapshot-captured",
              processId: process.pid,
            });
            await new Promise((resolve) => {
              releaseScheduler = resolve;
            });
          }
          return rows;
        };
        try {
          result = await accountOperations.reconcile();
        } finally {
          object[method] = original;
        }
        break;
      }
      case "releaseScheduler":
        releaseScheduler();
        break;
      case "approveRecovery":
        result = await ownership.approveRecovery(args);
        break;
      case "pendingExternal":
        result = await ownership.pendingExternal(args.resource);
        break;
      case "acquire":
        result = await ownership.acquire(args);
        break;
      case "checkpoint":
        result = await ownership.checkpoint(args.claim, args.input);
        break;
      case "release":
        result = await ownership.release(args);
        break;
      case "renew":
        result = await ownership.renew(args.claim, args.leaseMs);
        break;
      case "fencedWrite":
        result = await ownership.runFenced(args.claim, () =>
          db.set("worker-contract", args.key, true),
        );
        break;
      case "holdTransaction":
        result = await db.transact(async () => {
          const backendId = (
            await query(db, "SELECT pg_backend_pid() AS id", [], "get")
          ).id;
          process.send({
            event: "transaction-held",
            backendId,
            processId: process.pid,
          });
          await new Promise((resolve) => {
            releaseHeld = resolve;
          });
        });
        break;
      case "releaseTransaction":
        releaseHeld();
        break;
      case "mailClaim":
        result = await mail.claimAttempt(
          args.id,
          args.workerId,
          args.leaseMs,
          args.now,
        );
        break;
      case "mailComplete":
        result = await mail.markDelivered(args.claim, args.now);
        break;
      case "authenticationOpen": {
        const authenticationDb = args?.pauseConsumed
          ? pauseVerificationConsumption(db, async () => {
              process.send({ event: "verification-consumed" });
              await new Promise((resolve) => {
                releaseConsumed = resolve;
              });
            })
          : db;
        authentication = await createBetterAuthAuthentication({
          db: authenticationDb,
          config: {
            issuer: "https://entryway.example.test",
            betterAuthSecret: "contract-only-authentication-secret-long-enough",
          },
          mail: createMailFeature({
            outbox: mail,
            transport: { async deliver() {} },
          }),
        });
        break;
      }
      case "releaseConsumed":
        releaseConsumed();
        break;
      case "authenticationSend":
        result = await authentication.sendSignInCode(args.email);
        break;
      case "authenticationVerify": {
        const response = await authentication.verifySignInCode(args);
        result = { ok: response.ok, status: response.status };
        break;
      }
      case "securityOpen": {
        const storage = createAccountStorage(db, args.pds);
        accounts = {
          storage,
          async get(id) {
            return (
              (await storage.getByDid(id)) ?? (await storage.getByEmail(id))
            );
          },
        };
        proofs = createSecurityPrimitives({
          db,
          accounts,
          config: { betterAuthSecret: "contract-only-proof-secret" },
          legacy: {},
          authority: createAccountAuthority({ db, accounts }),
          mail: createMailFeature({
            outbox: mail,
            transport: { async deliver() {} },
          }),
        });
        break;
      }
      case "securityRate":
        result = await proofs.rate(
          args.email,
          "worker-budget",
          3,
          Number.MAX_SAFE_INTEGER,
        );
        break;
      case "securityIssue":
        result = await proofs.issue(
          "password-reset",
          await accounts.get(args.did),
          args.email,
        );
        break;
      case "securityConsume": {
        const consumed = await proofs.consume(args.token, "password-reset");
        result = { id: consumed.id, did: consumed.did };
        break;
      }
      case "close":
        await db.close();
        result = null;
        break;
      default:
        throw Error("InvalidWorkerCommand");
    }
    process.send({ id, ok: true, result });
  } catch (error) {
    // Fixture errors disclose only stable codes; database query parameters and
    // transport bodies must never appear in worker diagnostics.
    process.send({
      id,
      ok: false,
      code: error.code ?? error.error ?? error.name,
    });
  }
});
