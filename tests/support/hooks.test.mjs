import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const installer = join(root, "scripts/install-hooks.mjs");

function run(cwd, command, args, environment = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      CI: "",
      LEFTHOOK: "1",
      PATH: process.env.PATH.split(":")
        .filter((entry) => !entry.endsWith("/node_modules/.bin"))
        .join(":"),
    },
  });
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "entryway-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  for (const name of ["src", "scripts", "tests", ".github/workflows"])
    mkdirSync(join(dir, name), { recursive: true });
  for (const name of [
    "package.json",
    "lefthook.yml",
    "eslint.config.mjs",
    ".prettierignore",
    ".github/workflows/ci.yml",
  ]) {
    cpSync(join(root, name), join(dir, name));
  }
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  symlinkSync(join(root, "scripts/lint"), join(dir, "scripts/lint"), "dir");
  writeFileSync(
    join(dir, "scripts/example.mjs"),
    "export const script = true;\n",
  );
  writeFileSync(join(dir, "tests/example.mjs"), "export const test = true;\n");
  writeFileSync(join(dir, "src/example.mjs"), "export const value = 1;\n");
  return dir;
}

function install(dir) {
  return run(dir, process.execPath, [installer]);
}

function hook(dir) {
  return run(dir, join(dir, ".git/hooks/pre-commit"), []);
}

function snapshot(dir) {
  return {
    index: readFileSync(join(dir, ".git/index")),
    worktree: readFileSync(join(dir, "src/example.mjs")),
  };
}

test("hook runs real checks without modifying partially staged state", (t) => {
  const dir = fixture(t);
  assert.equal(install(dir).status, 0);
  assert.equal(install(dir).status, 0);
  execFileSync("git", ["add", "src/example.mjs"], { cwd: dir });
  writeFileSync(join(dir, "src/example.mjs"), "export const value = 2;\n");
  const before = snapshot(dir);
  const result = hook(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(snapshot(dir), before);
});

test("format and lint failures reject without changing the index or worktree", (t) => {
  for (const content of ["export const value=1;\n", "const unused = 1;\n"]) {
    const dir = fixture(t);
    assert.equal(install(dir).status, 0);
    execFileSync("git", ["add", "src/example.mjs"], { cwd: dir });
    writeFileSync(join(dir, "src/example.mjs"), content);
    const before = snapshot(dir);
    const result = hook(dir);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout + result.stderr,
      content.includes("unused") ? /no-unused-vars/ : /Code style issues/,
    );
    assert.deepEqual(snapshot(dir), before);
  }
});

test("missing Lefthook fails closed", (t) => {
  const dir = fixture(t);
  assert.equal(install(dir).status, 0);
  rmSync(join(dir, "node_modules"));
  const result = hook(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Lefthook is missing/);
});

test("missing hook dependencies fail without changing staged or working bytes", (t) => {
  for (const missing of ["lint", "formatter", "platform binary"]) {
    const dir = fixture(t);
    assert.equal(install(dir).status, 0);
    execFileSync("git", ["add", "src/example.mjs"], { cwd: dir });
    writeFileSync(join(dir, "src/example.mjs"), "export const value = 2;\n");

    if (missing === "lint") {
      rmSync(join(dir, "scripts/lint"));
    } else {
      rmSync(join(dir, "node_modules"));
      mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
      if (missing === "formatter") {
        symlinkSync(
          join(root, "node_modules/lefthook"),
          join(dir, "node_modules/lefthook"),
          "dir",
        );
        symlinkSync(
          join(root, "node_modules/.bin/lefthook"),
          join(dir, "node_modules/.bin/lefthook"),
        );
      } else {
        cpSync(
          join(root, "node_modules/lefthook"),
          join(dir, "node_modules/lefthook"),
          { recursive: true },
        );
        symlinkSync(
          "../lefthook/bin/index.js",
          join(dir, "node_modules/.bin/lefthook"),
        );
      }
    }
    const before = snapshot(dir);
    const result = hook(dir);
    assert.notEqual(
      result.status,
      0,
      `${missing}: ${result.stdout}${result.stderr}`,
    );
    assert.match(
      result.stdout + result.stderr,
      missing === "lint"
        ? /eslint/
        : missing === "formatter"
          ? /prettier/
          : /lefthook-/i,
    );
    assert.deepEqual(snapshot(dir), before, missing);
  }
});

test("installer ignores foreign repository environment while preserving configuration protections", (t) => {
  const dir = fixture(t);
  const foreign = fixture(t);
  execFileSync("git", ["add", "src/example.mjs"], { cwd: foreign });
  const foreignHook = join(foreign, ".git/hooks/pre-commit");
  writeFileSync(foreignHook, "foreign hook\n");
  const paths = [
    foreignHook,
    join(foreign, ".git/config"),
    join(foreign, ".git/index"),
  ];
  const before = paths.map((path) => readFileSync(path));
  const environment = {
    GIT_DIR: join(foreign, ".git"),
    GIT_WORK_TREE: foreign,
    GIT_COMMON_DIR: join(foreign, ".git"),
    GIT_INDEX_FILE: join(foreign, ".git/index"),
  };
  const result = run(dir, process.execPath, [installer], environment);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(join(dir, ".git/hooks/pre-commit"), "utf8"),
    /Entryway managed/,
  );
  assert.deepEqual(
    paths.map((path) => readFileSync(path)),
    before,
  );
  const globalConfig = join(dir, "global-config");
  writeFileSync(globalConfig, "[core]\n\thooksPath = custom-hooks\n");
  const refused = run(dir, process.execPath, [installer], {
    ...environment,
    GIT_CONFIG_GLOBAL: globalConfig,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /core.hooksPath is configured/);
  assert.deepEqual(
    paths.map((path) => readFileSync(path)),
    before,
  );
});

test("installer refuses custom hooks and core.hooksPath without changes", (t) => {
  const dir = fixture(t);
  const path = join(dir, ".git/hooks/pre-commit");
  writeFileSync(path, "#!/bin/sh\necho custom\n");
  const before = readFileSync(path);
  assert.notEqual(install(dir).status, 0);
  assert.deepEqual(readFileSync(path), before);
  execFileSync("git", ["config", "core.hooksPath", "custom-hooks"], {
    cwd: dir,
  });
  const config = readFileSync(join(dir, ".git/config"));
  assert.notEqual(install(dir).status, 0);
  assert.deepEqual(readFileSync(join(dir, ".git/config")), config);
  assert.deepEqual(readFileSync(path), before);
});
