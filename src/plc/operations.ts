import { randomUUID } from "node:crypto";
import { DomainError } from "../accounts/errors.js";
import {
  registryPdsFetch,
  registryPdsTarget,
} from "../pds/registry-transport.mjs";
import { readXrpcResponse } from "../pds/xrpc-response.js";
import type {
  OperationClaim,
  ExternalAttemptInput,
  ExternalAttempt,
} from "../database/operation-ownership.port.js";
import { signingKeyResult } from "../accounts/operation-ownership.js";
import type { CustodyInventoryTransactor } from "../database/custody.port.js";

import { fail } from "../accounts/input.mjs";
import { xrpc } from "../pds/client.mjs";

import type { AuthorityDatabase } from "../database/connection.js";
import type { createOperationOwnership } from "../accounts/operation-ownership.js";
import type { Secp256k1MigrationPlcSigner } from "./signing.js";
import type { Client } from "@did-plc/lib";

interface Account {
  did: string;
  email: string;
  status: string;
}
interface Pds {
  internalUrl: string;
  url: string;
}
interface Context {
  db: AuthorityDatabase;
  custody: CustodyInventoryTransactor;
  config: unknown;
  accounts: {
    plcSigner: Secp256k1MigrationPlcSigner;
    plcClient: Client;
    observeCustody?(did: string): Promise<unknown>;
    ownership: ReturnType<typeof createOperationOwnership>;
    placement?: {
      reserve(
        owner: OperationClaim,
        purpose: string,
        intent: string,
        steps: readonly string[],
        hostId?: string,
      ): Promise<{
        id: string;
        host_id: string;
        revision: number;
        public_target: string;
        target: string;
      }>;
      resolve(
        hostId: string,
        revision: number,
      ): Promise<{ url: string; internalUrl: string } | undefined>;
      finishUnusedUnboundKey(owner: OperationClaim): Promise<void>;
      releaseUnused(
        owner: OperationClaim,
        reservationId: string,
      ): Promise<unknown>;
      beginFirstDispatch(
        owner: OperationClaim,
        reservationId: string,
        input: ExternalAttemptInput,
      ): Promise<
        | { kind: "dispatched"; attempt: ExternalAttempt }
        | { kind: "existing"; attempt: ExternalAttempt }
        | { kind: "refused" }
        | { kind: "prior-dispatch" }
      >;
    };
    registryVerifier?: Parameters<typeof registryPdsFetch>[2];
    get(did: string): Promise<Account | null>;
    pdsFor(row: Account): Pds;
    assertNoMigration?(did: string): Promise<void>;
    serialized<T>(
      did: string,
      perform: () => Promise<T>,
      intent: { kind: string; request: unknown },
    ): Promise<T>;
  };
  sendCode(
    purpose: string,
    subject: string,
    destination: string,
    channel: string,
    did: string,
  ): Promise<unknown>;
  consumeCode(
    purpose: string,
    subject: string,
    code: unknown,
  ): Promise<boolean>;
  pdsCall(row: Account, method: string, body: unknown): Promise<unknown>;
  choosePds(id?: string): Pds;
}
function inputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("InvalidRequest", "Provide an operation object");
  return value as Record<string, unknown>;
}

/** Assemble account-authorized PLC confirmation, signing and submission.
 * Inject custody on db so confirmation consumption and release authorization
 * share one fenced transaction. Invalid proofs/candidates reject without release;
 * signed history proves authorization, not delivery or directory publication. */
export function createPlcOperations({
  db,
  custody,
  accounts,
  sendCode,
  consumeCode,
  pdsCall,
  choosePds,
}: Context) {
  const signer = accounts.plcSigner;
  const reserveSigningKey = async ({
    did,
    pdsId,
  }: { did?: string; pdsId?: string } = {}) => {
    const existing = did && (await accounts.get(did));
    if (!existing && accounts.placement) {
      if (pdsId !== undefined && (typeof pdsId !== "string" || !pdsId.trim()))
        throw new DomainError(
          "InvalidAccount",
          400,
          "Invalid data server selection",
        );
      const perform = async () => {
        const claim = accounts.ownership.currentClaim;
        if (!claim)
          throw new DomainError(
            "OperationLeaseLost",
            409,
            "Operation owner unavailable",
          );
        let reservation;
        try {
          reservation = await accounts.placement!.reserve(
            claim,
            "unbound-key",
            claim.requestDigest,
            ["reserve-signing-key"],
            pdsId,
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "PdsLifecycleIneligible"
          )
            throw error;
          if (!did) await accounts.placement!.finishUnusedUnboundKey(claim);
          throw new DomainError(
            "AccountUnavailable",
            409,
            "No eligible data server is available",
          );
        }
        const target = await accounts.placement!.resolve(
          reservation.host_id,
          reservation.revision,
        );
        if (
          !target ||
          target.url !== reservation.public_target ||
          target.internalUrl !== reservation.target
        ) {
          if (!did) await accounts.placement!.finishUnusedUnboundKey(claim);
          throw new DomainError(
            "OperationRecoveryRequired",
            409,
            "The reserved data server configuration is unavailable",
          );
        }
        const targetUrl = new URL(
          "/xrpc/com.atproto.server.reserveSigningKey",
          target.internalUrl,
        );
        try {
          registryPdsTarget(targetUrl, accounts.registryVerifier, 65536);
        } catch {
          if (did)
            await accounts.placement!.releaseUnused(claim, reservation.id);
          else await accounts.placement!.finishUnusedUnboundKey(claim);
          throw new DomainError(
            "AccountUnavailable",
            409,
            "The selected data server is unavailable",
          );
        }
        try {
          return await accounts.ownership.dispatch(
            {
              step: "reserve-signing-key",
              target: target.url,
              method: "com.atproto.server.reserveSigningKey",
              intent: did ? { did } : {},
              authorizeFirst: (owner, descriptor) =>
                accounts.placement!.beginFirstDispatch(
                  owner,
                  reservation.id,
                  descriptor,
                ),
            },
            {
              ...signingKeyResult,
              send: async () => {
                const response = await registryPdsFetch(
                  targetUrl,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(did ? { did } : {}),
                    signal: AbortSignal.timeout(15000),
                  },
                  accounts.registryVerifier,
                  65536,
                );
                return readXrpcResponse(
                  response,
                  target.internalUrl,
                  "com.atproto.server.reserveSigningKey",
                );
              },
              observe: () =>
                Promise.resolve({
                  state: did ? ("replay-safe" as const) : ("diverged" as const),
                }),
            },
          );
        } catch (error) {
          if (
            error instanceof DomainError &&
            error.code === "PdsLifecycleIneligible"
          ) {
            if (!did) await accounts.placement!.finishUnusedUnboundKey(claim);
            throw new DomainError(
              "AccountUnavailable",
              409,
              "The selected data server is unavailable",
            );
          }
          throw error;
        }
      };
      return did
        ? perform()
        : accounts.ownership.run(
            `unbound-key:${randomUUID()}`,
            {
              kind: "unbound-key",
              request: { pdsId: pdsId ?? null },
              completeOnReturn: true,
            },
            perform,
          );
    }
    const pds = existing ? accounts.pdsFor(existing) : choosePds(pdsId);
    const send = () =>
      xrpc(
        pds.internalUrl,
        "com.atproto.server.reserveSigningKey",
        did ? { did } : {},
      );
    if (!did) return send();
    return accounts.ownership.dispatch(
      {
        step: "reserve-signing-key",
        target: pds.url ?? pds.internalUrl,
        method: "com.atproto.server.reserveSigningKey",
        intent: { did },
      },
      {
        ...signingKeyResult,
        send,
        observe: () => Promise.resolve({ state: "replay-safe" as const }),
      },
    );
  };
  const requestPlcOperationSignature = async (row: Account) => {
    await accounts.assertNoMigration?.(row.did);
    return await sendCode(
      "plc-operation",
      `${row.did}:${row.email}`,
      row.email,
      "email",
      row.did,
    );
  };
  const signPlcOperation = async (
    row: Account,
    body: Record<string, unknown>,
  ) => {
    await accounts.assertNoMigration?.(row.did);
    await accounts.observeCustody?.(row.did);
    const current = await accounts.plcClient.getLastOp(row.did);
    if (current.type === "plc_tombstone")
      fail("InvalidRequest", "The identity is tombstoned");
    const allowed = new Set([
      "token",
      "rotationKeys",
      "alsoKnownAs",
      "verificationMethods",
      "services",
    ]);
    if (Object.keys(body).some((k) => !allowed.has(k)))
      fail("InvalidRequest", "Unknown operation field");
    let operation;
    let authorizing = false;
    try {
      const { token: _proof, ...replacement } = body;
      operation = await signer.signPublicUpdate(
        current,
        replacement,
        async (facts, cid) => {
          authorizing = true;
          const accepted = await db.transact(async () => {
            const currentAccount = await accounts.get(row.did);
            if (
              currentAccount?.did !== row.did ||
              currentAccount.email !== row.email ||
              ["deleted", "provisioning"].includes(currentAccount.status)
            )
              fail(
                "InvalidToken",
                "Account authority changed; request a new signature code",
              );
            await accounts.assertNoMigration?.(row.did);
            // Returning false commits ordinary failed-attempt accounting. Fence or
            // history failures throw and roll back proof and history together.
            if (
              !(await consumeCode(
                "plc-operation",
                `${row.did}:${row.email}`,
                body.token,
              ))
            )
              return false;
            await custody.recordSigned({
              id: crypto.randomUUID(),
              did: row.did,
              cid,
              operation: facts,
              kind: "signed",
              operationId: accounts.ownership.currentClaim!.operationId,
              provenance: "entryway-authorized",
              at: new Date().toISOString(),
            });
            return true;
          });
          if (!accepted)
            fail("InvalidToken", "Code is invalid, expired or already used");
        },
      );
    } catch (error) {
      if (authorizing) throw error;
      fail(
        "InvalidPlcOperation",
        "The requested identity operation is invalid or this entryway no longer has signing authority",
      );
    }
    // A lost response after commit spends the proof. History records release
    // authorization, not successful delivery or directory publication.
    return { operation };
  };
  const submitPlcOperation = async (
    row: Account,
    { operation }: { operation: unknown },
  ) => {
    await accounts.assertNoMigration?.(row.did);
    // The hosting PDS enforces its own key/handle/endpoint invariants and sequences
    // identity events. A migration-away operation is signed here and submitted to
    // the directory by its owner, rather than weakening the stock PDS constraints.
    await pdsCall(row, "com.atproto.identity.submitPlcOperation", {
      operation,
    });
    await accounts.observeCustody?.(row.did);
    return {};
  };
  const serialize = <T>(
    did: string,
    kind: string,
    request: unknown,
    perform: () => Promise<T>,
  ) => accounts.serialized(did, perform, { kind, request });
  return {
    reserveSigningKey: (input: { did?: string; pdsId?: string } = {}) =>
      input.did
        ? serialize(
            input.did,
            "plc-reserve",
            { pdsId: input.pdsId ?? null },
            () => reserveSigningKey(input),
          )
        : reserveSigningKey(input),
    requestPlcOperationSignature: (row: Account) =>
      serialize(row.did, "plc-proof", {}, () =>
        requestPlcOperationSignature(row),
      ),
    signPlcOperation: (row: Account, input: unknown) => {
      const body = inputRecord(input);
      const { token: _proof, ...publicIntent } = body;
      // This admission ends after returning the signature. The owner may publish
      // it independently later; Entryway cannot serialize third-party publication.
      return serialize(row.did, "plc-sign", publicIntent, () =>
        signPlcOperation(row, body),
      );
    },
    submitPlcOperation: (row: Account, { operation }: { operation: unknown }) =>
      serialize(row.did, "plc-submit", { operation }, () =>
        submitPlcOperation(row, { operation }),
      ),
  };
}
