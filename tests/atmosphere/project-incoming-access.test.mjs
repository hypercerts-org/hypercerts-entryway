import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { projectIncomingAccess } from "./project-incoming-access.mjs";

const project = "hypercerts-entryway-test";
const routes = {
  sourceUrl: "https://pds3.atmosbox.test",
  entrywayUrl: "https://entryway.atmosbox.test",
  destinationUrls: [
    "https://cluster1.atmosbox.test",
    "https://cluster2.atmosbox.test",
  ],
  plcUrl: "https://plc.atmosbox.test",
  mailpitUrl: "https://mailpit.atmosbox.test",
};
const fixture = () => ({
  schemaVersion: 1,
  project,
  network: { internal: true, physicalName: `${project}_atmosinabox` },
  observations: { configuration: "current" },
  trust: { certificateExists: true, certificatePath: "/private/secret" },
  secret: "never-project-this",
  endpoints: [
    ["pds", "pds3", routes.sourceUrl],
    ["application", "entryway", routes.entrywayUrl],
    ["application", "pds1", routes.destinationUrls[0]],
    ["application", "pds2", routes.destinationUrls[1]],
    ["plc", "plc", routes.plcUrl],
    ["application", "mail-capture", routes.mailpitUrl],
  ].map(([serviceType, service, url]) => ({
    serviceType,
    service,
    url,
    hostname: new URL(url).hostname,
    kind: "exact",
    token: "never-project-this",
  })),
});

test("projects only configured public origins", () => {
  const result = projectIncomingAccess(fixture(), project, routes);
  assert.deepEqual(result, { schemaVersion: 1, project, ...routes });
  assert.doesNotMatch(JSON.stringify(result), /secret|private|token/);
});

test("rejects invalid private sandbox metadata", () => {
  for (const mutate of [
    (access) => {
      access.project = "other";
    },
    (access) => {
      access.schemaVersion = 2;
    },
    (access) => {
      access.network.internal = false;
    },
    (access) => {
      access.network.physicalName = "other_atmosinabox";
    },
    (access) => {
      access.observations.configuration = "stale";
    },
    (access) => {
      access.trust.certificateExists = false;
    },
    (access) => {
      delete access.endpoints;
    },
  ]) {
    const access = fixture();
    mutate(access);
    assert.throws(() => projectIncomingAccess(access, project, routes));
  }
});

test("rejects absent, ambiguous and inconsistent endpoints", () => {
  for (const mutate of [
    (access) => {
      access.endpoints.shift();
    },
    (access) => {
      access.endpoints.push({ ...access.endpoints[0] });
    },
    (access) => {
      access.endpoints[0].service = "pds1";
    },
    (access) => {
      access.endpoints[0].serviceType = "application";
    },
    (access) => {
      access.endpoints[0].kind = "wildcard";
    },
    (access) => {
      access.endpoints[0].url = routes.plcUrl;
    },
    (access) => {
      access.endpoints[0].url += "/private";
    },
    (access) => {
      access.endpoints[0].url = "https://user:password@pds3.atmosbox.test";
    },
  ]) {
    const access = fixture();
    mutate(access);
    assert.throws(() => projectIncomingAccess(access, project, routes));
  }
});

test("rejects unsafe or inconsistent expected routes", () => {
  for (const overrides of [
    { sourceUrl: "http://pds3.atmosbox.test" },
    { sourceUrl: "https://user@pds3.atmosbox.test" },
    { sourceUrl: `${routes.sourceUrl}/path` },
    { sourceUrl: `${routes.sourceUrl}?token=secret` },
    { sourceUrl: routes.plcUrl },
    { destinationUrls: [routes.destinationUrls[0]] },
    { entrywayUrl: "https://wrong.atmosbox.test" },
  ]) {
    assert.throws(() =>
      projectIncomingAccess(fixture(), project, { ...routes, ...overrides }),
    );
  }
});

test("CLI projects a real JSON file without exposing extra fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "incoming-access-"));
  try {
    const accessPath = join(directory, "access.json");
    writeFileSync(accessPath, JSON.stringify(fixture()), { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./project-incoming-access.mjs", import.meta.url),
        ),
        accessPath,
        project,
        routes.sourceUrl,
        routes.entrywayUrl,
        ...routes.destinationUrls,
        routes.plcUrl,
        routes.mailpitUrl,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      project,
      ...routes,
    });
    assert.doesNotMatch(result.stdout, /secret|private|token/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI requires explicit arguments and fails without them", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./project-incoming-access.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage:/);
});
