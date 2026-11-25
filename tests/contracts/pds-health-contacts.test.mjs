import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPdsHealthContacts } from "../../dist/src/mail/pds-health-contacts.js";

test("health contacts are protected, validated and normalized", async () => {
  assert.deepEqual(await loadPdsHealthContacts(undefined), { hosts: {} });
  const directory = await mkdtemp(join(tmpdir(), "health-contacts-"));
  try {
    const path = join(directory, "contacts.json");
    await writeFile(
      path,
      JSON.stringify({
        fleet: " Fleet@Example.TEST ",
        hosts: { host: " PDS@example.test " },
      }),
      { mode: 0o600 },
    );
    const contacts = await loadPdsHealthContacts(path);
    assert.equal(contacts.fleet, "fleet@example.test");
    assert.equal(contacts.hosts.host, "pds@example.test");
    await chmod(path, 0o640);
    await assert.rejects(
      loadPdsHealthContacts(path),
      /InvalidPdsHealthContacts/,
    );
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ fleet: "bad\naddress" }));
    await assert.rejects(
      loadPdsHealthContacts(path),
      /InvalidPdsHealthContacts/,
    );
    await writeFile(
      path,
      JSON.stringify({ fleet: "fleet@example.test", unknown: true }),
    );
    await assert.rejects(
      loadPdsHealthContacts(path),
      /InvalidPdsHealthContacts/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
