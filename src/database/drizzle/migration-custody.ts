import { createHash } from "node:crypto";
import { publicKeyAlgorithm } from "../../plc/custody.js";
import { and, asc, eq } from "drizzle-orm";
import { PlcError } from "../../plc/errors.js";
import {
  validateCustodyInventory,
  validateSignedEvent,
} from "../../plc/custody.js";
import type { DatabaseExecutor } from "../executor.js";
import type {
  CustodyInventoryReader,
  CustodyInventoryTransactor,
} from "../custody.port.js";
import type { CustodyObservation, CustodyInventory } from "../../plc/types.js";
export function createCustodyInventoryStorage(
  db: DatabaseExecutor,
): CustodyInventoryReader & CustodyInventoryTransactor {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && value !== null)
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  const store: CustodyInventoryReader & CustodyInventoryTransactor = {
    async recordObservation(observation) {
      const exact = (value: object, keys: string[]) =>
        Object.keys(value).sort().join(",") === keys.sort().join(",");
      if (
        !exact(observation, [
          "directory",
          "did",
          "id",
          "at",
          "operationId",
          "entries",
          "snapshot",
        ]) ||
        typeof observation.directory !== "string" ||
        !/^https?:\/\//.test(observation.directory) ||
        new URL(observation.directory).username !== "" ||
        new URL(observation.directory).password !== "" ||
        !Array.isArray(observation.entries) ||
        !observation.entries.length ||
        observation.snapshot.eventId !== observation.id ||
        observation.snapshot.at !== observation.at ||
        observation.entries.some(
          (entry) =>
            !exact(entry, ["cid", "operation", "nullified"]) ||
            typeof entry.nullified !== "boolean",
        ) ||
        new Set(observation.entries.map((entry) => entry.cid)).size !==
          observation.entries.length ||
        canonical(
          observation.entries
            .filter((entry) => !entry.nullified)
            .map((entry) => entry.cid),
        ) !== canonical(observation.snapshot.chain) ||
        canonical(
          observation.entries
            .filter((entry) => entry.nullified)
            .map((entry) => entry.cid),
        ) !== canonical(observation.snapshot.nullified)
      )
        throw new PlcError(
          "InvalidCustodyObservation",
          "Public observation projection is inconsistent",
        );
      validateCustodyInventory({
        did: observation.did,
        keys: [],
        observation: observation.snapshot,
      });
      await db.transact(async () => {
        // This immutable public projection is the explicit support for every
        // observed/nullified event. Snapshot replacement cannot erase provenance.
        const row = {
          id: observation.id,
          did: observation.did,
          directory: observation.directory,
          value: canonical(observation),
        };
        await db.insert("custody_observations", row, { ignoreConflict: true });
        const retained = (
          await db.read("custody_observations", {
            where: eq(db.tables.custody_observations.id, observation.id),
            limit: 1,
          })
        )[0];
        if (canonical(retained) !== canonical(row))
          throw new PlcError("CustodyConflict", "Observation retry differs");
        const priorEvents = await db.read("custody_history", {
          where: eq(
            db.tables.custody_history.supporting_observation_id,
            observation.id,
          ),
        });
        // An exact retained retry must not regress a newer effective snapshot.
        if (priorEvents.length === observation.entries.length) return;
        const previous = await store.getByDid(observation.did);
        const old = previous?.observation;
        const next = observation.snapshot;
        // A different branch needs explicit nullification of our prior head.
        // Neither local timestamps nor publication inclusion establish authority.
        if (
          old &&
          ((!next.chain.includes(old.headCid) &&
            !next.nullified.includes(old.headCid)) ||
            old.nullified.some((cid) => !next.nullified.includes(cid)) ||
            old.chain.some(
              (cid) =>
                !next.chain.includes(cid) && !next.nullified.includes(cid),
            ))
        )
          throw new PlcError(
            "CustodyConflict",
            "Directory observation regresses or contradicts retained authority",
          );
        for (const entry of observation.entries) {
          if (!entry.nullified) {
            const index = next.chain.indexOf(entry.cid);
            if (
              entry.operation.prev !==
              (index === 0 ? null : next.chain[index - 1])
            )
              throw new PlcError(
                "InvalidCustodyObservation",
                "Public observation chain is inconsistent",
              );
          }
          await store.recordSigned({
            id: `${observation.id}:${entry.cid}`,
            did: observation.did,
            cid: entry.cid,
            operation: entry.operation,
            kind: entry.nullified ? "nullified" : "observed",
            supportingObservationId: observation.id,
            operationId: observation.operationId,
            provenance: entry.nullified
              ? "directory-asserted-nullification"
              : "directory-observed-publication",
            at: observation.at,
          });
        }
        const head = observation.entries.find(
          (entry) => entry.cid === next.headCid,
        )!;
        const keys: CustodyInventory["keys"] =
          head.operation.type === "plc_tombstone"
            ? []
            : [
                ...head.operation.rotationKeys.map((keyReference) => ({
                  keyReference,
                  purpose: "unknown-rotation" as const,
                  custodian: "unknown" as const,
                  algorithm: publicKeyAlgorithm(keyReference),
                  fingerprint: `sha256:${createHash("sha256").update(keyReference).digest("hex")}`,
                  lifecycle: "active" as const,
                  provenance: "directory-observed-unknown-custodian" as const,
                })),
                ...[head.operation.verificationMethods.atproto]
                  .filter((key): key is string => typeof key === "string")
                  .map((keyReference) => ({
                    keyReference,
                    purpose: "pds-repository" as const,
                    custodian: "unknown" as const,
                    algorithm: publicKeyAlgorithm(keyReference),
                    fingerprint: `sha256:${createHash("sha256").update(keyReference).digest("hex")}`,
                    lifecycle: "active" as const,
                    provenance: "directory-observed-unknown-custodian" as const,
                  })),
              ];
        // Directory authority does not identify custodians or govern issuer keys.
        // Retain attributed inventory independently; the snapshot/immutable head
        // supplies effective PLC authority, including removed or replaced keys.
        const attributed = (previous?.keys ?? []).filter(
          (item) => item.provenance !== "directory-observed-unknown-custodian",
        );
        const observed = keys.filter((item) =>
          item.purpose === "pds-repository"
            ? !attributed.some((known) => known.purpose === item.purpose)
            : !attributed.some(
                (known) =>
                  known.keyReference === item.keyReference &&
                  known.purpose !== "pds-repository" &&
                  known.purpose !== "oauth-issuer",
              ),
        );
        await store.save({
          did: observation.did,
          keys: [...attributed, ...observed],
          observation: next,
        });
      });
    },
    async recordSigned(input) {
      const event = validateSignedEvent(input);
      await db.transact(async () => {
        if (event.supportingObservationId !== undefined) {
          const support = await store.getObservation(
            event.supportingObservationId,
          );
          const entry = support?.entries.find((item) => item.cid === event.cid);
          if (
            !support ||
            support.did !== event.did ||
            support.at !== event.at ||
            support.operationId !== event.operationId ||
            !entry ||
            canonical(entry.operation) !== canonical(event.operation) ||
            event.kind !== (entry.nullified ? "nullified" : "observed")
          )
            throw new PlcError(
              "InvalidCustodyEvent",
              "Supporting observation differs",
            );
        }
        const facts = canonical(event.operation);
        await db.insert(
          "custody_operations",
          { did: event.did, cid: event.cid, operation: facts },
          { ignoreConflict: true },
        );
        const stored = (
          await db.read("custody_operations", {
            where: and(
              eq(db.tables.custody_operations.did, event.did),
              eq(db.tables.custody_operations.cid, event.cid),
            ),
            limit: 1,
          })
        )[0];
        if (stored?.operation !== facts)
          throw new PlcError(
            "CustodyConflict",
            "Immutable custody operation differs",
          );
        const row = {
          id: event.id,
          did: event.did,
          cid: event.cid,
          kind: event.kind,
          supporting_observation_id: event.supportingObservationId ?? null,
          operation_id: event.operationId,
          provenance: event.provenance,
          at: event.at,
        };
        await db.insert("custody_history", row, { ignoreConflict: true });
        const old = (
          await db.read("custody_history", {
            where: eq(db.tables.custody_history.id, event.id),
            limit: 1,
          })
        )[0];
        if (canonical(old) !== canonical(row))
          throw new PlcError("CustodyConflict", "Custody event retry differs");
        // Authorization is append-only evidence; it never promotes the snapshot.
      });
    },
    async getObservation(id) {
      const row = (
        await db.read("custody_observations", {
          where: eq(db.tables.custody_observations.id, id),
          limit: 1,
        })
      )[0];
      return row ? (JSON.parse(row.value) as CustodyObservation) : null;
    },
    async getHistory(did) {
      const events = await db.read("custody_history", {
        where: eq(db.tables.custody_history.did, did),
        // Presentation order only; PLC causality is predecessor-linked evidence.
        orderBy: [
          asc(db.tables.custody_history.at),
          asc(db.tables.custody_history.id),
        ],
      });
      return Promise.all(
        events.map(async (event) => {
          const facts = (
            await db.read("custody_operations", {
              where: and(
                eq(db.tables.custody_operations.did, did),
                eq(db.tables.custody_operations.cid, event.cid),
              ),
              limit: 1,
            })
          )[0];
          if (!facts)
            throw new PlcError(
              "InvalidCustodyEvent",
              "Custody operation is missing",
            );
          return validateSignedEvent({
            id: event.id,
            did,
            cid: event.cid,
            kind: event.kind,
            ...(event.supporting_observation_id === null
              ? {}
              : { supportingObservationId: event.supporting_observation_id }),
            operationId: event.operation_id,
            provenance: event.provenance,
            at: event.at,
            operation: JSON.parse(facts.operation),
          });
        }),
      );
    },
    async getByDid(did) {
      const row = (
        await db.read("migration_custody_inventory", {
          where: eq(db.tables.migration_custody_inventory.did, did),
          limit: 1,
        })
      )[0];
      return row
        ? validateCustodyInventory(JSON.parse(row.value) as CustodyInventory)
        : null;
    },
    async save(inventory) {
      const publicOnly = validateCustodyInventory(inventory);
      await db.transact(async () => {
        const where = eq(
          db.tables.migration_custody_inventory.did,
          publicOnly.did,
        );
        const values = {
          did: publicOnly.did,
          value: JSON.stringify(publicOnly),
          updated_at: new Date().toISOString(),
        };
        if (
          (await db.update("migration_custody_inventory", values, where)) === 0
        )
          await db.insert("migration_custody_inventory", values);
      });
    },
  };
  return store;
}
