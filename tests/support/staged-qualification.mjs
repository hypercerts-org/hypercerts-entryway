import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stagedObservation } from "./staged-qualification-policy.mjs";

process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
const [action, project, directory] = process.argv.slice(2);
if (
  !["before", "after"].includes(action) ||
  !/^hypercerts-entryway-[a-z0-9_-]+$/.test(project) ||
  !directory
)
  throw Error("Invalid staged qualification invocation");
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", ...options }).trim();
const docker = (args, options) =>
  run("docker", ["--context", "rootless", ...args], options);
const ids = docker([
  "ps",
  "--filter",
  `label=com.docker.compose.project=${project}`,
  "--filter",
  "label=com.docker.compose.service=pds1",
  "--format",
  "{{.ID}}",
])
  .split("\n")
  .filter(Boolean);
if (ids.length !== 1)
  throw Error("Expected one running qualification destination");
const inspection = JSON.parse(docker(["inspect", ids[0]]))[0];
const expectedCommand = ["node", "/app/services/pds/start-pds.mjs"];
if (JSON.stringify(inspection.Config.Cmd) !== JSON.stringify(expectedCommand))
  throw Error("Unexpected qualification destination command");
const processes = docker(["top", ids[0], "-eo", "pid,args"])
  .split("\n")
  .map((line) => line.trim().replace(/^\d+\s+/, ""));
if (processes.filter((line) => line === expectedCommand.join(" ")).length !== 1)
  throw Error("Qualification destination process is unavailable");
const entrywayIds = docker([
  "ps",
  "--filter",
  `label=com.docker.compose.project=${project}`,
  "--filter",
  "label=com.docker.compose.service=entryway",
  "--format",
  "{{.ID}}",
])
  .split("\n")
  .filter(Boolean);
if (entrywayIds.length !== 1)
  throw Error("Expected one running qualification Entryway");
const entryway = JSON.parse(docker(["inspect", entrywayIds[0]]))[0];
const launcher = inspection.Mounts.filter(
  (mount) => mount.Destination === "/app/services/pds/start-pds.mjs",
);
if (launcher.length !== 1 || launcher[0].RW)
  throw Error("Qualification launcher is not mounted read-only");
const projectionScript = `
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const c=JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH ?? '/config/config.json','utf8'));
const p=c.pds.find(p=>p.id===process.env.PDS_ID);
if (!p || p.stagedIncomingMigration!==true) throw Error('Staged profile unavailable');
const config={hostId:p.id,serviceDid:p.did,publicUrl:p.url,internalUrl:p.internalUrl,stagedIncomingMigration:p.stagedIncomingMigration,issuer:c.issuer,entrywayDid:c.serviceDid,jwtPublicHex:c.jwtPublicHex,plcRotationKeyDid:c.plcRotationKeyDid,plcUrl:c.plcUrl,handleDomains:c.handleDomains,devMode:true,disableSsrfProtection:true,rateLimitsEnabled:false,inviteRequired:false};
console.log(JSON.stringify({config,launcherSha256:createHash('sha256').update(readFileSync('/app/services/pds/start-pds.mjs')).digest('hex')}));`;
const projection = JSON.parse(
  docker(["exec", "-i", ids[0], "node", "--input-type=module"], {
    input: projectionScript,
  }),
);
run("git", ["diff", "--quiet"]);
if (run("git", ["ls-files", "--others", "--exclude-standard"]))
  throw Error("Untracked source prevents qualification provenance");
const binding = {
  checkoutTree: run("git", ["write-tree"]),
  checkoutCommit: run("git", ["rev-parse", "HEAD"]),
  entrywayContainerId: entryway.Id,
  entrywayRuntimeImageId: entryway.Image,
  entrywayStartedAt: entryway.State.StartedAt,
  containerId: inspection.Id,
  runtimeImageId: inspection.Image,
  startedAt: inspection.State.StartedAt,
  mountedLauncherSha256: projection.launcherSha256,
  mountedConfigProjection: projection.config,
  mountedConfigProjectionSha256: createHash("sha256")
    .update(JSON.stringify(projection.config))
    .digest("hex"),
};
const beforePath = `${directory}/staged-qualification-before.json`;
if (action === "before") {
  for (const name of [
    "staged-qualification-results.json",
    "staged-qualification.json",
  ])
    rmSync(`${directory}/${name}`, { force: true });
  writeFileSync(beforePath, JSON.stringify(binding), { mode: 0o600 });
} else {
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const results = JSON.parse(
    readFileSync(`${directory}/staged-qualification-results.json`, "utf8"),
  );
  const receipt = stagedObservation(before, binding, results);
  writeFileSync(
    `${directory}/staged-qualification.json`,
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "Staged sandbox observation recorded; registry qualification remains unavailable",
  );
}
