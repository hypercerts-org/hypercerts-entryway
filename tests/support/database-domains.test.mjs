import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { databaseDomains, databaseFiles } from "./database-domains.mjs";

test("database domains partition the complete original contract suite", () => {
  const original =
    `custody-history plc-policy plc-signing account-access account-schema account-security account-completion reconciliation-admission oauth-stores database-boundary lifecycle operation-ownership external-operation-ownership repository-verification migration migration-payload mail-ownership shared-authentication synthetic-client legacy service-auth experience entryway-extras plc-rejection xrpc-security external-workflow migration-boundary migration-custody incoming-arrival-storage controller-challenges pds-lifecycle pds-health-sweep pds-health-incidents pds-health pds-registry-enrollment authority-mode pds-registry-targets pds-registry-routes pds-registry`
      .split(" ")
      .map((name) => `tests/contracts/${name}.test.mjs`)
      .concat([
        "src/features/email-login/routes.test.mjs",
        "src/features/account-settings/operation-recovery-routes.test.mjs",
      ]);
  const shards = Object.keys(databaseDomains).flatMap(databaseFiles);
  assert.equal(new Set(shards).size, shards.length);
  assert.deepEqual([...shards].sort(), original.sort());
  assert.deepEqual(databaseFiles(), shards);
  assert.ok(shards.every(existsSync));
  assert.throws(() => databaseFiles("unknown"), /Unknown database domain/);
});

test("CI matrix is generated from the inventory and aggregate requires complete jobs", () => {
  const matrix = spawnSync(
    process.execPath,
    ["tests/support/database-domains.mjs", "--matrix"],
    { encoding: "utf8" },
  );
  assert.equal(matrix.status, 0);
  assert.deepEqual(JSON.parse(matrix.stdout), [
    ...Object.keys(databaseDomains),
    "postgresql-profile",
  ]);
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(
    ci,
    /domain: \$\{\{ fromJSON\(needs\.database-inventory\.outputs\.domains\) \}\}/,
  );
  const shards = ci.match(
    /^ {2}database-shards:\n[\s\S]*?(?=^ {2}[\w-]+:)/m,
  )?.[0];
  const aggregate = ci.match(/^ {2}databases:\n[\s\S]*?(?=^ {2}[\w-]+:)/m)?.[0];
  const inventory = ci.match(
    /^ {2}database-inventory:\n[\s\S]*?(?=^ {2}[\w-]+:)/m,
  )?.[0];
  assert.match(
    inventory,
    /domains=\$\(node tests\/support\/database-domains\.mjs --matrix\)\n\s+echo "domains=\$domains"/,
  );
  assert.match(shards, /fail-fast: false/);
  assert.match(aggregate, /if: always\(\)/);
  assert.match(aggregate, /needs: \[database-inventory, database-shards\]/);
  assert.match(
    aggregate,
    /test "\$INVENTORY_RESULT" = success && test "\$SHARDS_RESULT" = success/,
  );
});

test("inventory CLI works from a checkout path containing #", () => {
  const directory = mkdtempSync(join(tmpdir(), "database-#-"));
  try {
    const file = join(directory, "database-domains.mjs");
    copyFileSync("tests/support/database-domains.mjs", file);
    const result = spawnSync(process.execPath, [file, "--matrix"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      ...Object.keys(databaseDomains),
      "postgresql-profile",
    ]);
    for (const args of [
      [],
      ["--validate"],
      ["--validate", ""],
      ["--validate", "invalid"],
      ["--validate", "--matrix"],
      ["--matrix", "extra"],
    ]) {
      assert.notEqual(spawnSync(process.execPath, [file, ...args]).status, 0);
    }
    assert.equal(
      spawnSync(process.execPath, [file, "--validate", "routes"]).status,
      0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shell rejects invalid selectors before creating a sandbox", () => {
  const directory = mkdtempSync(join(tmpdir(), "database-selector-"));
  try {
    const bin = join(directory, "bin");
    const dockerCalls = join(directory, "docker-calls");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      '#!/bin/sh\nprintf "docker called\\n" >> "$DOCKER_CALLS"\nexit 1\n',
      { mode: 0o755 },
    );
    for (const command of ["git", "deno"]) {
      writeFileSync(join(bin, command), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
    }
    for (const domain of ["", "invalid", "--matrix"]) {
      const sandbox = join(directory, `sandbox-${domain || "empty"}`);
      const reports = join(directory, `reports-${domain || "empty"}`);
      const result = spawnSync(
        "bash",
        ["tests/local.sh", "fresh-group", "database-contracts"],
        {
          env: {
            PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(
              delimiter,
            ),
            HOME: directory,
            DATABASE_DOMAIN: domain,
            SANDBOX_PROJECT: "hypercerts-entryway-selector-test",
            SANDBOX_CHECKOUT: sandbox,
            ACCEPTANCE_REPORT_DIR: reports,
            DOCKER_CALLS: dockerCalls,
          },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0);
      if (domain) {
        assert.ok(result.stderr.includes(`Unknown database domain: ${domain}`));
      } else {
        assert.match(result.stderr, /Usage: database-domains\.mjs/);
      }
      assert.equal(existsSync(sandbox), false);
      assert.equal(existsSync(reports), false);
      assert.equal(existsSync(dockerCalls), false);
      assert.doesNotMatch(result.stdout, /phase=.*status=started/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
