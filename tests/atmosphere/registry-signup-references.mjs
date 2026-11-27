import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { openDatabase } from "../../dist/src/database/connection.js";
import { assertNoPdsHostReferences } from "../../dist/src/database/drizzle/pds-registry-enrollment-guard.js";

const configuration = {
  backend: "postgresql",
  url: process.env.REGISTRY_TEST_DATABASE_URL,
};
const first = await openDatabase(configuration, "registry-bootstrap");
const second = await openDatabase(configuration, "registry-bootstrap");
const candidate = "pds-second";
try {
  await first.transact(() => assertNoPdsHostReferences(first, candidate));
  await assert.rejects(
    first.transact(() => assertNoPdsHostReferences(first, "pds-serving")),
    /PdsEnrollmentReferencesExist/,
  );
  async function rolledBackRefusal(change) {
    await assert.rejects(
      first.transact(async () => {
        await change();
        await assert.rejects(
          assertNoPdsHostReferences(first, candidate),
          /PdsEnrollmentReferencesUnmapped|PdsEnrollmentReferencesExist/,
        );
        throw Error("rollback-test");
      }),
      /rollback-test/,
    );
  }
  await rolledBackRefusal(() =>
    first.execute(
      sql`UPDATE pds_placement_reservations SET host_id = 'pds-second'`,
      "run",
    ),
  );
  await rolledBackRefusal(() =>
    first.execute(sql`UPDATE custody_operations SET operation = '{}'`, "run"),
  );
  await rolledBackRefusal(() =>
    first.set("unclassified-workflow", "entry", { opaque: true }),
  );
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const writer = first.transact(async () => {
    await first.set("unclassified-workflow", "race", { opaque: true });
    entered();
    await gate;
  });
  await started;
  const check = second.transact(() =>
    assertNoPdsHostReferences(second, candidate),
  );
  release();
  await writer;
  await assert.rejects(check, /PdsEnrollmentReferencesUnmapped/);
  await first.delete("unclassified-workflow", "race");
  console.log(
    "signup host reference: historical mapping, corruption and concurrent writer refusal passed",
  );
} finally {
  await second.close();
  await first.close();
}
