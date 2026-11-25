import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import type { PdsLifecycleStore } from "../pds-lifecycle.port.js";

/** Internal storage only. Callers must authenticate the operator separately. */
export function createAuthorityPhase(
  db: DatabaseExecutor,
  lifecycle: PdsLifecycleStore,
  validateServing: () => Promise<void>,
) {
  const events = db.tables.authority_phase_events;
  async function read() {
    const [mode] = await db.read("authority_mode");
    const rows = await db.read("authority_phase");
    if (
      mode?.id !== 1 ||
      mode.mode !== "registry-bootstrap" ||
      rows.length !== 1 ||
      rows[0]?.id !== 1
    )
      throw new Error("AuthorityPhaseConflict");
    const row = rows[0];
    if (
      !(
        (row.phase === "bootstrap" && row.generation === 1) ||
        (row.phase === "registry-serving" && row.generation === 2)
      )
    )
      throw new Error("AuthorityPhaseConflict");
    return { phase: row.phase, generation: row.generation };
  }
  return {
    read: () => db.transact(read),
    async activate(expectedGeneration: number, commandKey: string) {
      if (
        expectedGeneration !== 1 ||
        typeof commandKey !== "string" ||
        !commandKey ||
        commandKey.length > 128
      )
        throw new Error("InvalidAuthorityPhaseRequest");
      return db.transact(async () => {
        const current = await read();
        const [prior] = await db.read("authority_phase_events", {
          where: eq(events.command_key, commandKey),
        });
        if (prior) {
          if (prior.expected_generation !== expectedGeneration)
            throw new Error("AuthorityPhaseConflict");
          return { phase: prior.phase, generation: prior.generation };
        }
        if (
          current.phase !== "bootstrap" ||
          current.generation !== expectedGeneration
        )
          throw new Error("AuthorityPhaseConflict");
        if (!(await lifecycle.hasTrustedAssociation()))
          throw new Error("AuthorityPhaseEnrollmentRequired");
        await validateServing();
        const changed = await db.update(
          "authority_phase",
          { phase: "registry-serving", generation: 2 },
          and(
            eq(db.tables.authority_phase.id, 1),
            eq(db.tables.authority_phase.phase, "bootstrap"),
            eq(db.tables.authority_phase.generation, expectedGeneration),
          )!,
        );
        if (changed !== 1) throw new Error("AuthorityPhaseConflict");
        await db.insert("authority_phase_events", {
          command_key: commandKey,
          expected_generation: expectedGeneration,
          phase: "registry-serving",
          generation: 2,
          principal_class: "global-admin",
          created_at: await db.databaseTime(),
        });
        return { phase: "registry-serving", generation: 2 };
      });
    },
  };
}
