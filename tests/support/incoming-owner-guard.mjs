import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

try {
  const [root, marker, project, checkout, context, state = ""] =
    process.argv.slice(2);
  const owner = dirname(marker);
  const runtime = dirname(owner);
  const controllerRoot = dirname(dirname(runtime));
  const expected =
    "hypercerts-entryway-" +
    createHash("sha256")
      .update(basename(owner) + "\n")
      .digest("hex")
      .slice(0, 32);
  function plain(path) {
    if (
      resolve(path) !== path ||
      realpathSync(path) !== path ||
      lstatSync(path).isSymbolicLink()
    )
      throw Error();
  }
  for (const path of [runtime, owner, marker, checkout]) plain(path);
  if (
    execFileSync(
      "git",
      ["-C", controllerRoot, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim() !== controllerRoot ||
    runtime !== join(controllerRoot, "tests/.runtime") ||
    !/^incoming-[A-Za-z0-9]{24}$/.test(basename(owner)) ||
    (root !== controllerRoot && root !== join(owner, "source")) ||
    marker !== join(owner, "owner.json") ||
    checkout !== join(owner, "atmosphereinabox") ||
    project !== expected ||
    (lstatSync(owner).mode & 0o777) !== 0o700 ||
    (lstatSync(marker).mode & 0o777) !== 0o600
  )
    throw Error();
  const data = JSON.parse(readFileSync(marker, "utf8"));
  if (
    data.project !== project ||
    data.checkout !== checkout ||
    data.context !== context
  )
    throw Error();
  if (state) {
    for (const path of [
      join(checkout, "state"),
      join(checkout, "state/manifest.json"),
      join(checkout, "compose.yaml"),
      join(root, "tests/atmosphere/stacks/incoming-source-mail.yaml"),
    ])
      plain(path);
    if (
      JSON.parse(readFileSync(join(checkout, "state/manifest.json"), "utf8"))
        .project !== project
    )
      throw Error();
  }
} catch {
  console.error("Invalid incoming controller ownership");
  process.exit(1);
}
