import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
function childCompletion(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
async function waitForHealthy(completion) {
  let exited = false;
  void completion.then(() => {
    exited = true;
  });
  for (let attempt = 0; attempt < 100 && !exited; attempt++) {
    try {
      if ((await fetch("http://127.0.0.1:38179/_health")).ok && !exited) return;
    } catch {
      /* startup */
    }
    await Promise.race([
      completion,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
  }
  throw new Error("BootstrapStartupFailed");
}
const source = JSON.parse(await readFile("/config/bootstrap.json", "utf8"));
const directory = await mkdtemp(join(tmpdir(), "registry-startup-"));
try {
  for (const [name, password] of [
    ["missing", undefined],
    ["number", 42],
    ["empty", ""],
    ["spaces", "  "],
    ["malformed", "\ud800"],
    ["valid", "valid-test-admin"],
  ]) {
    const config = { ...source, adminPassword: password };
    const configPath = join(directory, `${name}.json`);
    const statePath = join(directory, name);
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    if (name === "valid") continue;
    const child = spawn(process.execPath, ["dist/src/main.mjs"], {
      env: {
        ...process.env,
        AUTHORITY_MODE: "registry-bootstrap",
        SERVICE_CONFIG_PATH: configPath,
        STATE_DIRECTORY: statePath,
        DATABASE_BACKEND: "sqlite",
        DATABASE_URL: "",
        DEPLOYMENT_MODE: "single-node",
        PORT: "38179",
        PDS_REGISTRY_KEYRING_FILE: "",
        PDS_REGISTRY_TARGETS_FILE: "",
        PDS_REGISTRY_CA_FILE: "",
      },
      stdio: "ignore",
    });
    const status = await new Promise((resolve) => child.once("exit", resolve));
    assert.notEqual(status, 0, name);
    await assert.rejects(stat(statePath), { code: "ENOENT" });
  }
  const env = {
    ...process.env,
    AUTHORITY_MODE: "registry-bootstrap",
    SERVICE_CONFIG_PATH: join(directory, "valid.json"),
    STATE_DIRECTORY: join(directory, "valid"),
    DATABASE_BACKEND: "sqlite",
    DATABASE_URL: "",
    DEPLOYMENT_MODE: "single-node",
    PORT: "38179",
  };
  for (const key of [
    "PDS_REGISTRY_KEYRING_FILE",
    "PDS_REGISTRY_TARGETS_FILE",
    "PDS_REGISTRY_CA_FILE",
  ])
    delete env[key];
  const early = spawn(process.execPath, ["-e", "process.exit(42)"], {
    stdio: "ignore",
  });
  const earlyCompletion = childCompletion(early);
  const started = performance.now();
  await assert.rejects(
    waitForHealthy(earlyCompletion),
    /BootstrapStartupFailed/,
  );
  assert.ok(performance.now() - started < 3000);
  assert.equal((await earlyCompletion).code, 42);
  const child = spawn(process.execPath, ["dist/src/main.mjs"], {
    env,
    stdio: "ignore",
  });
  const completion = childCompletion(child);
  try {
    await waitForHealthy(completion);
  } finally {
    child.kill("SIGTERM");
    await completion;
  }
  console.log(
    "bootstrap startup rejects invalid admin credentials before database creation and accepts valid credentials",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
