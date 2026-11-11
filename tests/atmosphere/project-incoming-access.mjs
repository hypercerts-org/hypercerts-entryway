import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function origin(value) {
  if (typeof value !== "string") throw new Error("Invalid HTTPS origin");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (value !== parsed.origin && value !== `${parsed.origin}/`)
  ) {
    throw new Error("Invalid HTTPS origin");
  }
  return parsed.origin;
}

export function projectIncomingAccess(access, project, routes) {
  if (
    typeof project !== "string" ||
    !/^hypercerts-entryway(-[a-z0-9_-]+)?$/.test(project) ||
    access?.schemaVersion !== 1 ||
    access.project !== project ||
    access.network?.internal !== true ||
    access.network?.physicalName !== `${project}_atmosinabox` ||
    access.observations?.configuration !== "current" ||
    access.trust?.certificateExists !== true ||
    !Array.isArray(access.endpoints)
  ) {
    throw new Error("Invalid or stale private sandbox access");
  }
  if (
    !Array.isArray(routes?.destinationUrls) ||
    routes.destinationUrls.length !== 2
  ) {
    throw new Error("Expected two configured destination origins");
  }
  const expected = [
    ["pds", "pds3", origin(routes.sourceUrl)],
    ["application", "entryway", origin(routes.entrywayUrl)],
    ["application", "pds1", origin(routes.destinationUrls[0])],
    ["application", "pds2", origin(routes.destinationUrls[1])],
    ["plc", "plc", origin(routes.plcUrl)],
    ["application", "mail-capture", origin(routes.mailpitUrl)],
  ];
  if (new Set(expected.map((item) => item[2])).size !== expected.length) {
    throw new Error("Configured origins must be distinct");
  }
  for (const [serviceType, service, expectedOrigin] of expected) {
    const hostname = new URL(expectedOrigin).hostname;
    const matching = access.endpoints.filter(
      (endpoint) => endpoint?.hostname === hostname,
    );
    if (
      matching.length !== 1 ||
      matching[0].serviceType !== serviceType ||
      matching[0].service !== service ||
      matching[0].kind !== "exact" ||
      origin(matching[0].url) !== expectedOrigin
    ) {
      throw new Error("Missing, ambiguous or inconsistent sandbox endpoint");
    }
  }
  return {
    schemaVersion: 1,
    project,
    sourceUrl: expected[0][2],
    entrywayUrl: expected[1][2],
    destinationUrls: [expected[2][2], expected[3][2]],
    plcUrl: expected[4][2],
    mailpitUrl: expected[5][2],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [
    accessPath,
    project,
    sourceUrl,
    entrywayUrl,
    firstDestination,
    secondDestination,
    plcUrl,
    mailpitUrl,
    ...extra
  ] = process.argv.slice(2);
  if (!mailpitUrl || extra.length) {
    throw new Error(
      "usage: project-incoming-access.mjs <access.json> <project> <source-origin> <entryway-origin> <destination1-origin> <destination2-origin> <plc-origin> <mailpit-origin>",
    );
  }
  const access = JSON.parse(await readFile(accessPath, "utf8"));
  const projection = projectIncomingAccess(access, project, {
    sourceUrl,
    entrywayUrl,
    destinationUrls: [firstDestination, secondDestination],
    plcUrl,
    mailpitUrl,
  });
  process.stdout.write(`${JSON.stringify(projection)}\n`);
}
