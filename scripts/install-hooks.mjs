import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

try {
  const configured = spawnSync(
    "git",
    ["config", "--get-all", "core.hooksPath"],
    {
      encoding: "utf8",
    },
  );
  if (configured.status === 0) {
    throw new Error(
      "core.hooksPath is configured; resolve it manually before installing Entryway hooks.",
    );
  }
  if (configured.status !== 1)
    throw new Error("Could not inspect core.hooksPath.");
  const hook = resolve(
    execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      encoding: "utf8",
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
