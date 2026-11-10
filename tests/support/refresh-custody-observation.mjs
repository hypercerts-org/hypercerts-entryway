// Privileged managed operator invocation, not an HTTP administrative endpoint.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../../dist/src/database/connection.js";
import { loadDatabaseConfiguration } from "../../dist/src/config.mjs";
import { createAccounts } from "../../dist/src/compose-accounts.mjs";

export async function refreshCustodyObservation(accounts, did) {
  if (typeof did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(did))
    throw Object.assign(new Error("Expected one PLC DID"), {
      code: "InvalidDid",
    });
  // Composition retains admission and directory validation. No local account
  // lookup is required: departed identities remain observable, not authorized.
  const observation = await accounts.refreshCustodyObservation(did);
  return {
    did: observation.did,
    observationId: observation.id,
    headCid: observation.snapshot.headCid,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let db;
  try {
    if (
      process.argv.length !== 3 ||
      !/^did:plc:[a-z2-7]{24}$/.test(process.argv[2])
    )
      throw Object.assign(new Error("Expected one PLC DID"), {
        code: "InvalidDid",
      });
    const config = JSON.parse(
      await readFile(process.env.SERVICE_CONFIG_PATH, "utf8"),
    );
    db = await openDatabase(loadDatabaseConfiguration(process.env));
    const accounts = await createAccounts({ db, config });
    console.log(
      JSON.stringify(
        await refreshCustodyObservation(accounts, process.argv[2]),
      ),
    );
  } catch (error) {
    // Never expose configuration, transport responses or signed operations.
    const allowed = new Set([
      "InvalidDid",
      "OperationPending",
      "OperationConflict",
      "OperationBusy",
      "OperationRecoveryRequired",
      "InvalidCustodyObservation",
      "CustodyConflict",
    ]);
    console.error(
      JSON.stringify({
        error: allowed.has(error?.code) ? error.code : "CustodyRefreshFailed",
      }),
    );
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
