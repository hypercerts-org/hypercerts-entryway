import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";

const DAY = 24 * 60 * 60_000;

/**
 * Move one account's remembered-device sign-in back in time. A device row lives
 * in key_value_state as `oauth:device-accounts` / `<deviceId>/<did>` and counts
 * as stale after seven days. Only that account's rows change, so a sibling
 * account remembered on the same device keeps its own age.
 */
export function ageRememberedAccount(did, databasePath, days = 8) {
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  try {
    const rows = database
      .prepare(
        "SELECT key, value FROM key_value_state WHERE namespace='oauth:device-accounts' AND key LIKE ?",
      )
      .all(`%/${did}`);
    expect(rows.length).toBeGreaterThan(0);
    const past = { $date: new Date(Date.now() - days * DAY).toISOString() };
    const update = database.prepare(
      "UPDATE key_value_state SET value=? WHERE namespace='oauth:device-accounts' AND key=?",
    );
    for (const { key, value } of rows)
      update.run(
        JSON.stringify({
          ...JSON.parse(value),
          createdAt: past,
          updatedAt: past,
        }),
        key,
      );
  } finally {
    database.close();
  }
}
