import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const config = JSON.parse(await readFile("/config/bootstrap.json", "utf8"));
const contacts = JSON.parse(
  await readFile("/config/health-contacts.json", "utf8"),
);
assert.equal(new URL(config.issuer).protocol, "https:");
const auth = `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`;
const phase = process.argv[2];
if (!["stale", "recovery"].includes(phase)) throw new Error("InvalidTestPhase");
const deadline = Date.now() + (phase === "stale" ? 70_000 : 15_000);
const subject =
  phase === "stale"
    ? "Entryway PDS monitoring stale"
    : "Entryway PDS health recovered";
const expected = phase === "stale" ? 1 : 2;
let observed = false;
while (Date.now() < deadline) {
  const response = await fetch(
    new URL("/admin/pds-registry/hosts/pds-monitor", config.issuer),
    { headers: { authorization: auth, "x-bootstrap-node": "bootstrap-a" } },
  );
  assert.equal(response.status, 200);
  const detail = await response.json();
  const incident = detail.incident;
  const state = phase === "stale" ? "open" : "closed";
  const notices = incident?.notices ?? [];
  const expectedPhase = phase === "stale" ? "open" : "recovery";
  const delivered =
    notices.filter(
      (item) => item.phase === expectedPhase && item.state === "delivered",
    ).length === 2;
  if (
    incident?.cause === "monitoring-stale" &&
    incident.state === state &&
    delivered
  ) {
    const counts = [];
    for (const recipient of [contacts.fleet, contacts.hosts["pds-monitor"]]) {
      const search = new URL("/api/v1/search", process.env.MAILPIT_URL);
      search.searchParams.set("query", `to:${recipient}`);
      const mail = await (await fetch(search)).json();
      counts.push(
        mail.messages.filter((message) => message.Subject === subject).length,
      );
    }
    if (counts.every((count) => count === expected)) {
      observed = true;
      break;
    }
    if (counts.some((count) => count > expected))
      throw new Error("DuplicateStaleNotification");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(observed, true, `missing ${phase} monitoring incident or mail`);
console.log(
  `monitoring ${phase}: both operator notices observed through Mailpit`,
);
