// Host-side AiaB launch helper. Its state does not grant qualification authority.
import { execFileSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const [action, project, sandboxArg] = process.argv.slice(2);
if (
  !["launch", "probe", "verify", "cleanup"].includes(action) ||
  !/^hypercerts-entryway-[a-z0-9_-]+$/.test(project) ||
  !sandboxArg
)
  throw Error("Invalid controller launch invocation");
const sandbox = realpathSync(sandboxArg);
const runtime = realpathSync(join(root, "tests/.runtime"));
if (!sandbox.startsWith(`${runtime}/`))
  throw Error("Sandbox is outside the owned runtime");
const access = JSON.parse(readFileSync(join(sandbox, "access.json"), "utf8"));
if (
  access.schemaVersion !== 1 ||
  access.project !== project ||
  access.network?.internal !== true ||
  access.observations?.configuration !== "current"
)
  throw Error("Sandbox access identity mismatch");
const env = { ...process.env };
delete env.DOCKER_HOST;
delete env.DOCKER_CONTEXT;
const context = process.env.ENTRYWAY_DOCKER_CONTEXT ?? "rootless";
if (!["rootless", "default"].includes(context))
  throw Error("Unsupported Entryway Docker context");
const run = (args, options = {}) =>
  (
    execFileSync("docker", ["--context", context, ...args], {
      encoding: "utf8",
      env,
      ...options,
    }) ?? ""
  ).trim();
const endpoint = run([
  "context",
  "inspect",
  context,
  "--format",
  "{{.Endpoints.docker.Host}}",
]);
const security = JSON.parse(
  run(["info", "--format", "{{json .SecurityOptions}}"]),
);
const validContext =
  context === "rootless"
    ? /^unix:\/\/\/run\/user\/[^/]+\/docker\.sock$/.test(endpoint) &&
      Array.isArray(security) &&
      security.includes("name=rootless")
    : endpoint === "unix:///var/run/docker.sock";
if (!validContext) throw Error("Unexpected Entryway Docker endpoint");
const stateDir = join(sandbox, ".controller-launch");
const statePath = join(stateDir, "state.json");
const overlay = join(stateDir, "compose.json");
const networkOverlay = process.env.ENTRYWAY_TEST_GATEWAY_NETWORK_OVERLAY;
if (
  networkOverlay &&
  (networkOverlay !== join(sandbox, ".controller-gateway", "network.yaml") ||
    realpathSync(networkOverlay) !== networkOverlay)
)
  throw Error("Invalid gateway network overlay");
const compose = (args, includeOverlay = true) =>
  run(
    [
      "compose",
      "--project-name",
      project,
      "-f",
      join(sandbox, "compose.yaml"),
      ...(includeOverlay ? ["-f", overlay] : []),
      ...(includeOverlay && networkOverlay ? ["-f", networkOverlay] : []),
      ...args,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
function toolImage() {
  const images = JSON.parse(run(["image", "inspect", `${project}:local`]));
  if (images.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(images[0].Id))
    throw Error("Controller tooling image unavailable");
  return images[0].Id;
}
const sealedPath = "/app/services/pds/controller-sealed";
const bootstrap = [
  "import { createHash, verify } from 'node:crypto';",
  "import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { registerHooks } from 'node:module';",
  "import { pathToFileURL } from 'node:url';",
  "const [launcherPath, digest, configPath, publicKey] = process.argv.slice(1);",
  "let launcher, config;",
  "try {",
  "launcher = readFileSync(launcherPath);",
  "config = readFileSync(configPath);",
  "const signature = readFileSync(configPath + '.sig');",
  "if (createHash('sha256').update(launcher).digest('hex') !== digest || !verify(null, config, Buffer.from(publicKey, 'base64').toString(), signature)) throw Error();",
  "} catch { console.log('ControllerLaunchInputMismatch'); process.exit(1); }",
  "const privateConfig = mkdtempSync('/tmp/controller-launch-') + '/config.json';",
  "writeFileSync(privateConfig, config, { mode: 0o400, flag: 'wx' });",
  "process.env.SERVICE_CONFIG_PATH = privateConfig;",
  "const launcherUrl = pathToFileURL(launcherPath).href;",
  "registerHooks({ load(url, context, nextLoad) { return url === launcherUrl ? { format: 'module', source: launcher, shortCircuit: true } : nextLoad(url, context); } });",
  "await import(launcherUrl);",
].join(" ");

function launchCommand({ launcherDigest, configMac, publicKey }) {
  return [
    "node",
    "--input-type=module",
    "-e",
    bootstrap,
    `${sealedPath}/launcher-${launcherDigest}.mjs`,
    launcherDigest,
    `${sealedPath}/config-${configMac}.json`,
    publicKey,
  ];
}

function current(command) {
  const ids = run([
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
  if (ids.length !== 1) throw Error("Expected one running destination");
  const value = JSON.parse(run(["inspect", ids[0]]))[0];
  if (
    !value.State.Running ||
    value.Config.Labels?.["com.docker.compose.project"] !== project ||
    value.Config.Labels?.["com.docker.compose.service"] !== "pds1" ||
    JSON.stringify(value.Config.Cmd) !== JSON.stringify(command)
  )
    throw Error("Unexpected destination identity");
  const processes = run(["top", value.Id, "-eo", "pid"])
    .split("\n")
    .map((line) => line.trim())
    .filter((pid) => /^\d+$/.test(pid))
    .filter((pid) => {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .split("\0")
          .slice(0, -1);
        return JSON.stringify(argv) === JSON.stringify(command);
      } catch {
        return false;
      }
    });
  if (processes.length !== 1) throw Error("Destination process unavailable");
  const [pid] = processes;
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const processStarted = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!/^\d+$/.test(processStarted ?? ""))
    throw Error("Destination process identity unavailable");
  return { value, pid, processStarted };
}
function privatePath(path, directory = false) {
  const file = lstatSync(path);
  if (
    (directory ? !file.isDirectory() : !file.isFile() || file.nlink !== 1) ||
    file.isSymbolicLink() ||
    file.uid !== process.getuid() ||
    (file.mode & (directory ? 0o077 : 0o277)) !== 0
  )
    throw Error("Unsafe controller launch state");
}
if (networkOverlay) privatePath(networkOverlay);
function volume(name, role) {
  const info = JSON.parse(run(["volume", "inspect", name]))[0];
  if (
    info.Name !== name ||
    info.Labels?.["com.docker.compose.project"] !== project ||
    info.Labels?.["entryway.controller.role"] !== role
  )
    throw Error("Controller volume identity mismatch");
}
const verifier = `const fs=require('node:fs'),crypto=require('node:crypto');const key=fs.readFileSync('/key/mac.key');const names=fs.readdirSync('/sealed');const launch=names.filter(n=>/^launcher-[0-9a-f]{64}\\.mjs$/.test(n));const config=names.filter(n=>/^config-[0-9a-f]{64}\\.json$/.test(n));if(key.length!==32||names.length!==3||launch.length!==1||config.length!==1||!names.includes(config[0]+'.sig'))process.exit(1);for(const name of names){const s=fs.lstatSync('/sealed/'+name);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o222)!==0)process.exit(1)}const d=crypto.createHash('sha256').update(fs.readFileSync('/sealed/'+launch[0])).digest('hex');const bytes=fs.readFileSync('/sealed/'+config[0]);const m=crypto.createHmac('sha256',key).update(bytes).digest('hex');if(!crypto.verify(null,bytes,Buffer.from(process.argv[1],'base64').toString(),fs.readFileSync('/sealed/'+config[0]+'.sig')))process.exit(1);if(launch[0]!=='launcher-'+d+'.mjs'||config[0]!=='config-'+m+'.json')process.exit(1);process.stdout.write(JSON.stringify({launcherDigest:d,configMac:m}));`;
function checkSnapshot(state) {
  if (state.toolImage !== toolImage())
    throw Error("Controller tooling image changed");
  volume(state.inputVolume, "inputs");
  volume(state.keyVolume, "key");
  const observed = JSON.parse(
    run([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0:0",
      "--mount",
      `type=volume,src=${state.inputVolume},dst=/sealed,readonly`,
      "--mount",
      `type=volume,src=${state.keyVolume},dst=/key,readonly`,
      "--entrypoint",
      "node",
      state.toolImage,
      "-e",
      verifier,
      state.publicKey,
    ]),
  );
  if (
    observed.launcherDigest !== state.launcherDigest ||
    observed.configMac !== state.configMac
  )
    throw Error("Launch snapshot changed");
}
function inspectBinding(state) {
  privatePath(stateDir, true);
  privatePath(statePath);
  privatePath(overlay);
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(state.publicKey) ||
    !/^[0-9a-f]{64}$/.test(state.launcherDigest) ||
    !/^[0-9a-f]{64}$/.test(state.configMac) ||
    !state.inputVolume.startsWith(`${project}-sealed-input-`) ||
    !state.keyVolume.startsWith(`${project}-sealed-key-`)
  )
    throw Error("Invalid snapshot identity");
  checkSnapshot(state);
  const command = launchCommand(state);
  const { value, pid, processStarted } = current(command);
  if (
    value.Id !== state.containerId ||
    value.Image !== state.imageId ||
    value.State.StartedAt !== state.startedAt ||
    value.RestartCount !== state.restartCount ||
    pid !== state.pid ||
    processStarted !== state.processStarted
  )
    throw Error("Destination incarnation changed");
  const mounts = value.Mounts.filter(
    (item) => item.Destination === "/app/services/pds/controller-sealed",
  );
  if (
    mounts.length !== 1 ||
    mounts[0].RW ||
    mounts[0].Name !== state.inputVolume ||
    value.Mounts.some((mount) => mount.Name === state.keyVolume)
  )
    throw Error("Launch mount changed");
}
if (action === "cleanup") {
  const directories = [stateDir, `${stateDir}-retired`].filter((directory) => {
    try {
      privatePath(directory, true);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
  const volumes = [];
  for (const role of ["inputs", "key"]) {
    const prefix = `${project}-sealed-${role === "inputs" ? "input" : "key"}-`;
    const names = run([
      "volume",
      "ls",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      `label=entryway.controller.role=${role}`,
    ])
      .split("\n")
      .filter(Boolean);
    for (const name of names) {
      if (
        !name.startsWith(prefix) ||
        !/^[0-9a-f]{32}$/.test(name.slice(prefix.length))
      )
        throw Error("Unexpected labelled controller volume");
      volume(name, role);
      volumes.push(name);
    }
  }
  const sealedDestination = volumes.some((name) =>
    run([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      "label=com.docker.compose.service=pds1",
      "--filter",
      `volume=${name}`,
    ]),
  );
  if (sealedDestination)
    compose(
      ["up", "-d", "--no-deps", "--force-recreate", "--wait", "pds1"],
      false,
    );
  for (const name of volumes) run(["volume", "rm", name]);
  for (const directory of directories) rmSync(directory, { recursive: true });
} else if (action === "launch" || action === "probe") {
  mkdirSync(stateDir, { mode: 0o700 });
  const before = current(["node", "/app/services/pds/start-pds.mjs"]);
  const trustedToolImage = toolImage();
  const launcher = readFileSync(join(root, "tests/support/start-pds.mjs"));
  const config = run(["exec", before.value.Id, "cat", "/config/config.json"]);
  const parsed = JSON.parse(config);
  if (
    !Array.isArray(parsed.pds) ||
    parsed.pds.filter((pds) => pds.id === "pds1").length !== 1 ||
    !parsed.pds.some(
      (pds) => pds.id === "pds1" && pds.stagedIncomingMigration === true,
    )
  )
    throw Error("Staged destination unavailable");
  const configBytes = Buffer.from(config);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const configSignature = sign(null, configBytes, privateKey);
  const exportedKey = publicKey.export({ type: "spki", format: "pem" });
  const suffix = randomBytes(16).toString("hex");
  const inputVolume = `${project}-sealed-input-${suffix}`;
  const keyVolume = `${project}-sealed-key-${suffix}`;
  for (const [name, role] of [
    [inputVolume, "inputs"],
    [keyVolume, "key"],
  ])
    run([
      "volume",
      "create",
      "--label",
      `com.docker.compose.project=${project}`,
      "--label",
      `entryway.controller.role=${role}`,
      name,
    ]);
  const writer = `const fs=require('node:fs'),c=require('node:crypto');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const v=JSON.parse(s),key=c.randomBytes(32),l=Buffer.from(v.launcher,'base64'),p=Buffer.from(v.config,'base64'),d=c.createHash('sha256').update(l).digest('hex'),m=c.createHmac('sha256',key).update(p).digest('hex');fs.writeFileSync('/key/mac.key',key,{mode:0o400,flag:'wx'});fs.writeFileSync('/sealed/launcher-'+d+'.mjs',l,{mode:0o400,flag:'wx'});fs.writeFileSync('/sealed/config-'+m+'.json',p,{mode:0o400,flag:'wx'});fs.writeFileSync('/sealed/config-'+m+'.json.sig',Buffer.from(v.configSignature,'base64'),{mode:0o400,flag:'wx'});process.stdout.write(JSON.stringify({launcherDigest:d,configMac:m}))})`;
  const identity = JSON.parse(
    run(
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        `type=volume,src=${inputVolume},dst=/sealed`,
        "--mount",
        `type=volume,src=${keyVolume},dst=/key`,
        "--entrypoint",
        "node",
        trustedToolImage,
        "-e",
        writer,
      ],
      {
        input: JSON.stringify({
          launcher: launcher.toString("base64"),
          config: configBytes.toString("base64"),
          configSignature: configSignature.toString("base64"),
        }),
      },
    ),
  );
  if (
    identity.launcherDigest !==
      createHash("sha256").update(launcher).digest("hex") ||
    !/^[0-9a-f]{64}$/.test(identity.configMac)
  )
    throw Error("Invalid launch snapshot identity");
  identity.publicKey = Buffer.from(exportedKey).toString("base64");
  const command = launchCommand(identity);
  writeFileSync(
    overlay,
    JSON.stringify({
      services: {
        pds1: {
          command,
          volumes: [`${inputVolume}:${sealedPath}:ro`],
        },
      },
      volumes: { [inputVolume]: { external: true } },
    }),
    { mode: 0o400, flag: "wx" },
  );
  checkSnapshot({
    inputVolume,
    keyVolume,
    toolImage: trustedToolImage,
    ...identity,
  });
  if (action === "probe") {
    // Alter the input through a second mount after the host has verified it.
    const changeConfig = (restore) =>
      run([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        `type=volume,src=${inputVolume},dst=/sealed`,
        "--entrypoint",
        "node",
        trustedToolImage,
        "-e",
        `const fs=require('node:fs'),path=process.argv[1];fs.chmodSync(path,0o600);if(process.argv[2]==='restore')fs.truncateSync(path,fs.statSync(path).size-1);else fs.appendFileSync(path,'\\n');fs.chmodSync(path,0o400);`,
        `/sealed/config-${identity.configMac}.json`,
        restore ? "restore" : "alter",
      ]);
    changeConfig(false);
    try {
      compose(["up", "-d", "--no-deps", "--force-recreate", "pds1"]);
      const id = run([
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        "label=com.docker.compose.service=pds1",
      ]);
      if (!/^[0-9a-f]{64}$/.test(id) || id === before.value.Id)
        throw Error("Expected a new destination for the launch probe");
      if (
        run(["wait", id], { timeout: 15_000 }) !== "1" ||
        run(["logs", id]) !== "ControllerLaunchInputMismatch"
      )
        throw Error("Changed startup configuration was accepted");
      const exited = JSON.parse(run(["inspect", id]))[0];
      if (exited.State.Running || exited.RestartCount !== 0)
        throw Error("Unexpected launch probe process state");
    } finally {
      changeConfig(true);
    }
    checkSnapshot({
      inputVolume,
      keyVolume,
      toolImage: trustedToolImage,
      ...identity,
    });
    console.log(
      "Launch refused config changed after the host check, before startup",
    );
    process.exit(0);
  }
  compose(["up", "-d", "--no-deps", "--force-recreate", "--wait", "pds1"]);
  const after = current(command);
  const state = {
    containerId: after.value.Id,
    imageId: after.value.Image,
    toolImage: trustedToolImage,
    startedAt: after.value.State.StartedAt,
    restartCount: after.value.RestartCount,
    pid: after.pid,
    processStarted: after.processStarted,
    inputVolume,
    keyVolume,
    ...identity,
  };
  if (
    after.value.Id === before.value.Id ||
    after.value.Image !== before.value.Image
  )
    throw Error("Unexpected destination replacement");
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o400, flag: "wx" });
  inspectBinding(state);
  console.log(
    "Controller launch snapshot started; qualification remains unavailable",
  );
} else {
  privatePath(stateDir, true);
  privatePath(statePath);
  inspectBinding(JSON.parse(readFileSync(statePath, "utf8")));
  console.log("Controller launch snapshot matches current incarnation");
}
