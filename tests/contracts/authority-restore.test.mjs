import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreAuthorityFiles } from "../support/authority-restore.mjs";

test("restoration attempts all backups and verifies bytes and permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "authority-restore-"));
  try {
    const paths = ["issuer", "pds1", "pds2"].map((name) => join(dir, name));
    for (const path of paths)
      await writeFile(path, "{invalid live JSON", { mode: 0o644 });
    await writeFile(`${paths[0]}.verification-test`, "issuer original");
    await writeFile(`${paths[2]}.verification-test`, "pds2 original");
    await assert.rejects(restoreAuthorityFiles(paths, "test"), {
      message: "Sandbox authority restoration failed",
    });
    assert.equal(await readFile(paths[0], "utf8"), "issuer original");
    assert.equal(await readFile(paths[2], "utf8"), "pds2 original");
    for (const path of [paths[0], paths[2]])
      assert.equal((await stat(path)).mode & 0o7777, 0o600);
    await writeFile(`${paths[1]}.verification-test`, "pds1 original");
    await restoreAuthorityFiles(paths, "test");
    assert.equal(await readFile(paths[1], "utf8"), "pds1 original");
    assert.equal((await stat(paths[1])).mode & 0o7777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed restoration never restarts services", () => {
  const script = `source tests/support/authority-restore.sh
configcmd() { return 1; }
compose() { echo unsafe-restart >&2; }
restore_authority_and_restart`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const success = spawnSync(
    "bash",
    ["-c", script.replace("return 1", "return 0")],
    { encoding: "utf8" },
  );
  assert.equal(success.status, 0);
  assert.equal(success.stderr.trim(), "unsafe-restart");
});

test("real EXIT trap dispatches restoration before fleet restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "authority-trap-"));
  try {
    const root = process.cwd();
    const marker = "dummy-sensitive-marker";
    const issuer = join(dir, "issuer.json");
    const pds1 = join(dir, "pds1.json");
    const pds2 = join(dir, "pds2.json");
    const loader = join(dir, "redirect.mjs");
    const wrapper = `import * as fs from 'node:fs/promises';
const map = p => typeof p === 'string' ? p.replace(/^\\/pds1-config\\/config.json/, process.env.TEST_PDS1).replace(/^\\/pds2-config\\/config.json/, process.env.TEST_PDS2) : p;
export const readFile = (p,...a) => fs.readFile(map(p),...a);
export const writeFile = (p,...a) => fs.writeFile(map(p),...a);
export const copyFile = (a,b,...c) => fs.copyFile(map(a),map(b),...c);
export const chmod = (p,...a) => fs.chmod(map(p),...a);
export const stat = (p,...a) => fs.stat(map(p),...a);
export const mkdir = fs.mkdir;`;
    await writeFile(
      loader,
      `import { registerHooks } from 'node:module';
registerHooks({resolve(specifier, context, next) {
 if (specifier === 'node:fs/promises' && /(?:operational-state-probe|authority-restore)\\.mjs$/.test(context.parentURL))
  return {url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(wrapper)}), shortCircuit: true};
 return next(specifier, context);
}});`,
    );
    const env = {
      ...process.env,
      SERVICE_CONFIG_PATH: issuer,
      TEST_PDS1: pds1,
      TEST_PDS2: pds2,
    };
    const probe = join(root, "tests/support/operational-state-probe.mjs");
    const runProbe = (mode) =>
      spawnSync(process.execPath, ["--import", loader, probe, mode, "test"], {
        encoding: "utf8",
        env,
      });
    await writeFile(issuer, `{ "secret": "${marker}`);
    let result = runProbe("project-key");
    assert.match(result.stderr, /SANDBOX_CONFIG_READ_FAILED/);
    assert.ok(!result.stderr.includes(marker));
    await writeFile(issuer, '{"jwtPublicHex":"original"}');
    await writeFile(pds1, `{ "secret": "${marker}`);
    result = runProbe("project-key");
    assert.match(result.stderr, /SANDBOX_CONFIG_READ_FAILED/);
    assert.ok(!result.stderr.includes(marker));
    await writeFile(
      join(dir, "run-authority-drills.sh"),
      await readFile(join(root, "tests/support/run-authority-drills.sh")),
    );
    await writeFile(
      join(dir, "authority-restore.sh"),
      await readFile(join(root, "tests/support/authority-restore.sh")),
    );
    await writeFile(
      join(dir, "operational-common.sh"),
      `set -euo pipefail
root=${JSON.stringify(root)}
artifacts=${JSON.stringify(dir)}
project=test
record_candidate() { :; }
remove_owned() { :; }
compose() {
  if [[ "$*" == *" configure node "* ]]; then
    local mode="$7"
    if [[ "$mode" == rotate ]]; then
      printf '%s' '{"secret":"${marker}' > "$SERVICE_CONFIG_PATH"
      printf '%s' '{"secret":"${marker}' > "$TEST_PDS1"
      printf '%s' '{"secret":"${marker}' > "$TEST_PDS2"
      if [[ "$MISSING_BACKUP" == yes ]]; then rm "$TEST_PDS1.verification-$8"; fi
      return 1
    fi
    node --import ${JSON.stringify(loader)} ${JSON.stringify(probe)} "$mode" "$8" "\${9:-}"
  elif [[ "$1" == restart ]]; then echo restart >> ${JSON.stringify(join(dir, "restarts"))};
  else :; fi
}
`,
    );
    const stubBin = join(dir, "bin");
    await (await import("node:fs/promises")).mkdir(stubBin);
    await writeFile(join(stubBin, "cp"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    // The drill's fixture-log pipeline needs a consumer, not host Python.
    await writeFile(
      join(stubBin, "python3"),
      "#!/bin/sh\nexec node -e 'process.stdin.resume()'\n",
      { mode: 0o755 },
    );
    for (const missing of ["yes", "no"]) {
      await writeFile(issuer, '{"jwtPublicHex":"original"}');
      await writeFile(pds1, '{"jwtPublicHex":"original"}');
      await writeFile(pds2, '{"jwtPublicHex":"original"}');
      await rm(join(dir, "restarts"), { force: true });
      result = spawnSync("bash", [join(dir, "run-authority-drills.sh")], {
        encoding: "utf8",
        env: {
          ...env,
          MISSING_BACKUP: missing,
          PATH: `${stubBin}:${process.env.PATH}`,
        },
      });
      assert.notEqual(result.status, 0);
      assert.ok(!(result.stdout + result.stderr).includes(marker));
      assert.equal(
        await readFile(issuer, "utf8"),
        '{"jwtPublicHex":"original"}',
      );
      assert.equal(await readFile(pds2, "utf8"), '{"jwtPublicHex":"original"}');
      if (missing === "yes") {
        await assert.rejects(readFile(join(dir, "restarts")));
      } else {
        assert.equal(
          await readFile(pds1, "utf8"),
          '{"jwtPublicHex":"original"}',
        );
        assert.equal(
          (await readFile(join(dir, "restarts"), "utf8")).trim(),
          "restart",
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
