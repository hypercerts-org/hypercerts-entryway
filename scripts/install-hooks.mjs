import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

const launcher = `#!/bin/sh
# Entryway managed pre-commit hook; install with npm run hooks:install.
root=$(git rev-parse --show-toplevel) || exit 1
lefthook="$root/node_modules/.bin/lefthook"
if [ ! -x "$lefthook" ]; then
  echo "Entryway: Lefthook is missing; install dependencies and run npm run hooks:install (see docs/testing.md)." >&2
  exit 1
fi
GIT_OPTIONAL_LOCKS=0
export GIT_OPTIONAL_LOCKS
exec "$lefthook" run entryway-checks --no-auto-install "$@"
`;

const gitEnv = { ...process.env };
for (const name of [
  "GIT_CONFIG",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_GRAFT_FILE",
  "GIT_SHALLOW_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
])
  delete gitEnv[name];

try {
  const cwd = realpathSync(process.cwd());
  const git = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)
    .map((entry) => {
      try {
        const directory = realpathSync(entry);
        if (
          directory === cwd ||
          directory.startsWith(cwd + sep) ||
          directory.split(sep).includes("node_modules")
        )
          return null;
        const executable = realpathSync(join(directory, "git"));
        if (
          executable === cwd ||
          executable.startsWith(cwd + sep) ||
          executable.split(sep).includes("node_modules")
        )
          return null;
        accessSync(executable, constants.X_OK);
        return statSync(executable).isFile() ? executable : null;
      } catch {
        return null;
      }
    })
    .find(Boolean);
  if (!git)
    throw new Error(
      "Could not find Git outside the project and node_modules PATH entries.",
    );
  const configured = spawnSync(git, ["config", "--get-all", "core.hooksPath"], {
    encoding: "utf8",
    env: gitEnv,
  });
  if (configured.status === 0) {
    throw new Error(
      "core.hooksPath is configured; resolve it manually before installing Entryway hooks.",
    );
  }
  if (configured.status !== 1)
    throw new Error("Could not inspect core.hooksPath.");
  const hook = resolve(
    execFileSync(git, ["rev-parse", "--git-path", "hooks/pre-commit"], {
      encoding: "utf8",
      env: gitEnv,
    }).trim(),
  );
  let existing;
  try {
    existing = lstatSync(hook);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (!existing.isFile() || readFileSync(hook, "utf8") !== launcher) {
      throw new Error(
        `Existing hook at ${hook}; preserve or remove it manually before installation.`,
      );
    }
    chmodSync(hook, existing.mode | 0o111);
  } else {
    writeFileSync(hook, launcher, { flag: "wx", mode: 0o755 });
  }
  console.log(`Entryway pre-commit hook installed at ${hook}.`);
} catch (error) {
  console.error(`Hook installation refused: ${error.message}`);
  process.exitCode = 1;
}
