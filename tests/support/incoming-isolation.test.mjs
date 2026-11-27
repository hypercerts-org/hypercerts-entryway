import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();

function run(mode, command = "incoming-before-signed-submit") {
  const dir = mkdtempSync(join(tmpdir(), "incoming-isolation-"));
  const bin = join(dir, "bin"),
    foreign = join(dir, "foreign"),
    log = join(dir, "docker.log");
  mkdirSync(bin);
  mkdirSync(foreign);
  writeFileSync(join(foreign, "sentinel"), "untouched");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
printf '%s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *'context inspect'*) echo unix:///run/user/1000/docker.sock ;;
  *'info --format'*) echo '["name=rootless"]' ;;
  *'container ls --all'*) [[ "$MODE" != collision ]] || echo stopped-container; [[ "$MODE" != lookup-fails ]] || exit 1 ;;
  *'image inspect'*) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "git"),
    `#!/bin/bash
if [[ "$1" == clone ]]; then
  mkdir -p "${"${@: -1}"}/state"
  touch "${"${@: -1}"}/compose.yaml"
  if [[ "$MODE" == owned ]]; then
    printf '{"project":"%s"}' "$SANDBOX_PROJECT" > "${"${@: -1}"}/state/manifest.json"
  elif [[ "$MODE" == foreign ]]; then
    printf '{"project":"foreign"}' > "${"${@: -1}"}/state/manifest.json"
  fi
  exit 1
fi
exec "${realGit}" "$@"
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [join(root, "tests/local.sh"), command], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_LOG: log,
      MODE: mode,
      SANDBOX_PROJECT: "hypercerts-entryway-foreign",
      SANDBOX_CHECKOUT: foreign,
      ACCEPTANCE_REPORT_DIR: join(foreign, "reports"),
      KEEP_FAILED_SANDBOX: "1",
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  assert.equal(readFileSync(join(foreign, "sentinel"), "utf8"), "untouched");
  assert.equal(existsSync(join(foreign, "reports")), false);
  rmSync(dir, { recursive: true, force: true });
  return { result, calls };
}

test("stopped-container collision and lookup failure never invoke teardown", () => {
  for (const mode of ["collision", "lookup-fails"]) {
    const { result, calls } = run(mode);
    assert.notEqual(result.status, 0);
    assert.match(calls, /container ls --all/);
    assert.doesNotMatch(calls, / down |image rm/);
  }
});

test("failed startup tears down only an established owned project", () => {
  for (const mode of ["missing", "foreign", "owned"]) {
    const { result, calls } = run(mode);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(calls, /hypercerts-entryway-foreign/);
    assert.doesNotMatch(calls, / down |image rm/);
  }
});

test("direct internal invocation without controller manifest is rejected", () => {
  const { result, calls } = run(
    "missing",
    "_incoming-before-signed-submit-run",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing incoming controller ownership/);
  assert.equal(calls, "");
});

test("direct internal invocation rejects missing or foreign ownership marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "incoming-owner-"));
  try {
    const bin = join(dir, "bin"),
      owner = join(dir, "owner"),
      checkout = join(owner, "atmosphereinabox");
    mkdirSync(bin);
    mkdirSync(owner, { mode: 0o700 });
    mkdirSync(checkout);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/bash
case "$*" in
  *'context inspect'*) echo unix:///run/user/1000/docker.sock ;;
  *'info --format'*) echo '["name=rootless"]' ;;
  *) echo unexpected-docker >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const marker = join(owner, "owner.json");
    for (const value of [
      null,
      { project: "hypercerts-entryway-foreign", checkout, context: "rootless" },
    ]) {
      if (value) writeFileSync(marker, JSON.stringify(value));
      const result = spawnSync(
        "bash",
        [join(root, "tests/local.sh"), "_incoming-before-signed-submit-run"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            SANDBOX_CHECKOUT: checkout,
            SANDBOX_PROJECT: "hypercerts-entryway-owned",
            ACCEPTANCE_REPORT_DIR: join(dir, "reports"),
            INCOMING_OWNER_MANIFEST: marker,
          },
        },
      );
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stderr, /unexpected-docker/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forged allocation fails before internal runner writes or Docker", () => {
  const runtime = join(root, "tests/.runtime");
  const owner = mkdtempSync(join(runtime, "incoming-"));
  const checkout = join(owner, "atmosphereinabox");
  const marker = join(owner, "owner.json");
  const reports = join(owner, "reports");
  try {
    mkdirSync(checkout);
    writeFileSync(
      marker,
      JSON.stringify({
        project: "hypercerts-entryway-forged",
        checkout,
        context: "rootless",
      }),
      { mode: 0o600 },
    );
    for (const script of [
      join(root, "tests/local.sh"),
      join(root, "tests/support/run-incoming-before-signed-submit.sh"),
    ]) {
      const args = script.endsWith("local.sh")
        ? ["_incoming-before-signed-submit-run"]
        : [root, checkout, "hypercerts-entryway-forged", "rootless", "before"];
      const result = spawnSync("bash", [script, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          SANDBOX_CHECKOUT: checkout,
          SANDBOX_PROJECT: "hypercerts-entryway-forged",
          ACCEPTANCE_REPORT_DIR: reports,
          INCOMING_OWNER_MANIFEST: marker,
        },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid incoming controller ownership/);
      assert.equal(existsSync(reports), false);
      assert.deepEqual(
        readFileSync(marker, "utf8"),
        JSON.stringify({
          project: "hypercerts-entryway-forged",
          checkout,
          context: "rootless",
        }),
      );
    }
  } finally {
    rmSync(owner, { recursive: true, force: true });
  }
});

test("symlinked checkout is rejected before internal runner writes", () => {
  const owner = join(
    root,
    "tests/.runtime",
    `incoming-${randomBytes(12).toString("hex")}`,
  );
  mkdirSync(owner, { mode: 0o700 });
  const target = join(owner, "target"),
    checkout = join(owner, "atmosphereinabox");
  const marker = join(owner, "owner.json"),
    reports = join(owner, "reports");
  const project = `hypercerts-entryway-${createHash("sha256")
    .update(owner.split("/").at(-1) + "\n")
    .digest("hex")
    .slice(0, 32)}`;
  try {
    mkdirSync(target);
    symlinkSync(target, checkout);
    writeFileSync(
      marker,
      JSON.stringify({ project, checkout, context: "rootless" }),
      { mode: 0o600 },
    );
    const result = spawnSync(
      "bash",
      [join(root, "tests/local.sh"), "_incoming-before-signed-submit-run"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SANDBOX_CHECKOUT: checkout,
          SANDBOX_PROJECT: project,
          ACCEPTANCE_REPORT_DIR: reports,
          INCOMING_OWNER_MANIFEST: marker,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid incoming controller ownership/);
    assert.equal(existsSync(reports), false);
  } finally {
    rmSync(owner, { recursive: true, force: true });
  }
});

function lifecycle(command, mode) {
  const dir = mkdtempSync(join(tmpdir(), "incoming-lifecycle-"));
  const bin = join(dir, "bin"),
    log = join(dir, "calls"),
    foreign = join(dir, "foreign");
  mkdirSync(bin);
  mkdirSync(foreign);
  writeFileSync(join(foreign, "sentinel"), "safe");
  const realNode = process.execPath,
    realPython = spawnSync("which", ["python3"], {
      encoding: "utf8",
    }).stdout.trim();
  const script = (name, content) =>
    writeFileSync(join(bin, name), `#!/bin/bash\n${content}\n`, {
      mode: 0o755,
    });
  script(
    "git",
    `if [[ "$1" == clone ]]; then mkdir -p "\${@: -1}/.git"; exit 0; fi
if [[ "$*" == *'checkout --quiet --detach'* ]]; then exit 0; fi
if [[ "$*" == *'rev-parse HEAD'* ]]; then echo 26cf1f60f81b491b065dfc830efd27aba8b89a54; exit 0; fi
exec "${realGit}" "$@"`,
  );
  script(
    "python3",
    `if [[ "$1" == */tests/atmosphere/install.py ]]; then exit 0; fi
exec "${realPython}" "$@"`,
  );
  script(
    "node",
    `case "$1" in */tests/atmosphere/validate-access.mjs) exit 0;; */tests/atmosphere/project-incoming-access.mjs) echo '{}'; exit 0;; esac
exec "${realNode}" "$@"`,
  );
  script(
    "deno",
    `echo "deno $* db=\${DATABASE_BACKEND-unset} url=\${DATABASE_URL-unset} mode=\${DEPLOYMENT_MODE-unset} late=\${ENTRYWAY_LATE_CUTOVER-unset} history=\${ENTRYWAY_TRANSFER_HISTORY-unset}" >> "$MOCK_LOG"
if [[ "$*" == *'sandbox create'* ]]; then
 mkdir -p "$SANDBOX_CHECKOUT/state"; printf '{"project":"%s"}' "$SANDBOX_PROJECT" > "$SANDBOX_CHECKOUT/state/manifest.json"
 touch "$SANDBOX_CHECKOUT/compose.real"
 if [[ "$MODE" == owner-fail ]]; then ln -s compose.real "$SANDBOX_CHECKOUT/compose.yaml"; else touch "$SANDBOX_CHECKOUT/compose.yaml"; fi
fi
[[ "$*" != *'access --json'* ]] || echo '{}'`,
  );
  script(
    "docker",
    `echo "docker $* db=\${DATABASE_BACKEND-unset} url=\${DATABASE_URL-unset}" >> "$MOCK_LOG"
case "$*" in
 *'context inspect'*) echo unix:///run/user/1000/docker.sock;;
 *'info --format'*) echo '["name=rootless"]';;
 *'config --format json'*) count=0; [[ ! -f "$MOCK_DIR/count" ]] || read -r count < "$MOCK_DIR/count"; count=$((count + 1)); echo "$count" > "$MOCK_DIR/count"; if [[ "$MODE" == transient-* && "$count" == "\${MODE#transient-}" && ! -f "$MOCK_DIR/failed" ]]; then touch "$MOCK_DIR/failed"; echo transient-lookup-failed >> "$MOCK_LOG"; exit 1; fi; if [[ "$MODE" == compose-fail ]]; then echo '{"name":"foreign"}'; elif [[ "$MODE" == foreign-resource ]]; then printf '{"name":"%s","volumes":{"data":{"name":"%s_data"}}}' "$SANDBOX_PROJECT" "$SANDBOX_PROJECT"; else printf '{"name":"%s"}' "$SANDBOX_PROJECT"; fi;;
 *'volume ls --format'*) [[ "$MODE" != foreign-resource ]] || echo "\${SANDBOX_PROJECT}_data";;
 *'volume inspect'*) echo '[{"Labels":{"com.docker.compose.project":"foreign"}}]';;
 *'image ls'*) [[ ! -f "$MOCK_DIR/started" || -f "$MOCK_DIR/removed" ]] || echo image-id;;
 *'image rm'*) touch "$MOCK_DIR/removed";;
 *'sandbox up'*) :;;
 *'compose'*' up '*) touch "$MOCK_DIR/started";;
 *'compose'*' ps --quiet entryway'*) echo container-id;;
 *'compose'*' restart entryway'*) touch "$MOCK_DIR/restarted";;
 *'compose'*' run '*'INCOMING_BEFORE_SIGNED_SUBMIT=1'*|*'compose'*' run '*'INCOMING_AFTER_SIGNED_PUBLICATION=1'*)
   barrier=$(printf '%s\\n' "$@" | grep '^.*/.incoming-barrier.*:/run/incoming-' | cut -d: -f1)
   if [[ "$MODE" == restart-owner-fail ]]; then rm "$SANDBOX_CHECKOUT/compose.yaml"; ln -s compose.real "$SANDBOX_CHECKOUT/compose.yaml"; fi
   touch "$barrier/ready"; for i in {1..100}; do [[ -f "$barrier/release" ]] && exit 0; sleep .1; done; exit 1;;
 *'image inspect'*) echo pds-image;;
 *'inspect'*'pds1-1'*) echo pds-image;;
 *'inspect'*'State.Health.Status'*) echo healthy;;
 *'inspect'*'State.StartedAt'*) if [[ -f "$MOCK_DIR/restarted" ]]; then echo 'image after'; else echo 'image before'; fi;;
 *'run --rm -i --entrypoint sh'*|*'exec -i '*' sh -c '*) (cd "$(dirname "$INCOMING_SOURCE_FILES")/source" && xargs -d '\\n' sha256sum);;
esac`,
  );
  const result = spawnSync("bash", [join(root, "tests/local.sh"), command], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_LOG: log,
      MOCK_DIR: dir,
      MODE: mode,
      SANDBOX_PROJECT: "hypercerts-entryway-foreign",
      SANDBOX_CHECKOUT: foreign,
      ACCEPTANCE_REPORT_DIR: join(foreign, "reports"),
      DATABASE_BACKEND: "postgresql",
      DATABASE_URL: "postgresql://foreign/db",
      DEPLOYMENT_MODE: "multi-node",
      ENTRYWAY_INCOMING_RESTART: "1",
      ENTRYWAY_LATE_CUTOVER: "1",
      ENTRYWAY_TRANSFER_HISTORY: "1",
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  assert.equal(readFileSync(join(foreign, "sentinel"), "utf8"), "safe");
  assert.equal(existsSync(join(foreign, "reports")), false);
  const owners = [
    ...calls.matchAll(
      /(\/[^\s:]*\/tests\/\.runtime\/incoming-[A-Za-z0-9]{24})/g,
    ),
  ].map((m) => m[1]);
  const preserved = result.stderr.match(
    /Guard rejected this run; preserved (\S+) without teardown/,
  );
  const preservedExists = preserved
    ? existsSync(join(preserved[1], "owner.json"))
    : false;
  if (preserved) owners.push(preserved[1]);
  for (const owner of owners) rmSync(owner, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  return { result, calls, preservedExists };
}

test("owned launchers reject owner and Compose failures before lifecycle actions", () => {
  for (const command of [
    "incoming-before-signed-submit",
    "incoming-after-signed-publication",
    "incoming-stock",
  ]) {
    for (const mode of ["owner-fail", "compose-fail", "foreign-resource"]) {
      const { result, calls } = lifecycle(command, mode);
      assert.notEqual(result.status, 0, `${command} ${mode}`);
      assert.doesNotMatch(
        calls,
        /(?:sandbox up|compose .* (?:up|restart|down) |image rm)/,
      );
      assert.doesNotMatch(
        calls,
        /(?:sandbox up|compose .* (?:up|restart|down))[^\n]*postgresql:\/\/foreign/,
      );
    }
  }
});

test("one-shot Compose lookup rejection remains fatal across launcher children", () => {
  for (const command of [
    "incoming-before-signed-submit",
    "incoming-after-signed-publication",
    "incoming-stock",
  ]) {
    for (const attempt of [1, 2, 3]) {
      const { result, calls, preservedExists } = lifecycle(
        command,
        `transient-${attempt}`,
      );
      assert.equal(
        result.status,
        75,
        `${command} attempt ${attempt}: ${result.stderr}`,
      );
      assert.match(calls, /transient-lookup-failed/);
      assert.equal(
        (calls.match(/config --format json/g) ?? []).length,
        attempt,
      );
      assert.equal(preservedExists, true);
      assert.doesNotMatch(
        calls,
        /compose [^\n]* (?:restart entryway|down --volumes)|image rm/,
      );
      if (attempt <= 2)
        assert.doesNotMatch(calls, /sandbox up --build|compose [^\n]* up /);
    }
  }
  for (const command of [
    "incoming-before-signed-submit",
    "incoming-after-signed-publication",
  ]) {
    const { result, calls, preservedExists } = lifecycle(
      command,
      "transient-5",
    );
    assert.equal(result.status, 75, `${command}: ${result.stderr}`);
    assert.equal(preservedExists, true);
    assert.match(calls, /transient-lookup-failed/);
    assert.equal((calls.match(/config --format json/g) ?? []).length, 5);
    assert.match(calls, /sandbox up --build/);
    assert.doesNotMatch(
      calls,
      /compose [^\n]* (?:restart entryway|down --volumes)|image rm/,
    );
  }
});

test("owned launchers select SQLite and perform only owned lifecycle cleanup", () => {
  for (const command of [
    "incoming-before-signed-submit",
    "incoming-after-signed-publication",
    "incoming-stock",
  ]) {
    const { result, calls } = lifecycle(command, "success");
    assert.equal(
      result.status,
      0,
      `${command}: ${result.stderr}\n${result.stdout}`,
    );
    assert.match(
      calls,
      /sandbox up --build db=sqlite url=unset mode=single-node/,
    );
    assert.doesNotMatch(
      calls,
      /(?:sandbox up|compose .* (?:up|restart|down))[^\n]*postgresql:\/\/foreign|hypercerts-entryway-foreign/,
    );
    assert.match(calls, /compose .* down --volumes/);
    assert.match(calls, /image rm hypercerts-entryway-/);
    if (command === "incoming-stock") {
      assert.match(calls, /sandbox create[^\n]*late=unset history=unset/);
      assert.match(calls, /sandbox up --build[^\n]*late=unset history=unset/);
      assert.match(calls, /INCOMING_PUBLIC_JOURNEY=1/);
    } else {
      assert.match(calls, /sandbox create[^\n]*late=1 history=1/);
      assert.match(calls, /sandbox up --build[^\n]*late=1 history=1/);
      assert.match(calls, /compose .* restart entryway/);
    }
  }
});

test("restart rechecks ownership and refuses restart and teardown after ownership loss", () => {
  for (const command of [
    "incoming-before-signed-submit",
    "incoming-after-signed-publication",
  ]) {
    const { result, calls } = lifecycle(command, "restart-owner-fail");
    assert.notEqual(result.status, 0);
    assert.match(calls, /sandbox up --build/);
    assert.doesNotMatch(
      calls,
      /compose [^\n]* (?:restart entryway|down --volumes)|image rm/,
    );
  }
});

test("ambient restart flag cannot make an unowned fresh group remove image tags", () => {
  const dir = mkdtempSync(join(tmpdir(), "incoming-ambient-"));
  const bin = join(dir, "bin"),
    log = join(dir, "docker.log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
 echo "$*" >> "$MOCK_LOG"
 case "$*" in
  *'context inspect'*) echo unix:///run/user/1000/docker.sock;;
  *'info --format'*) echo '["name=rootless"]';;
  *'image ls'*) echo foreign-image;;
 esac
`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync(
      "bash",
      [join(root, "tests/local.sh"), "fresh-group", "incoming-public-journey"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MOCK_LOG: log,
          ENTRYWAY_INCOMING_RESTART: "1",
          SANDBOX_PROJECT: "hypercerts-entryway-foreign",
          SANDBOX_CHECKOUT: join(dir, "checkout"),
          ACCEPTANCE_REPORT_DIR: join(dir, "reports"),
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid incoming controller ownership/);
    assert.doesNotMatch(
      readFileSync(log, "utf8"),
      /(?: up | restart | down |image rm)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
