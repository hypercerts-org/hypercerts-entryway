import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Negative parser fixtures only; these are never application profile receipts.
for (const fault of ["omitted profile", "one process presented as two nodes"]) {
  test(`profile collection rejects ${fault}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "entryway-profile-parser-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const entries = [
      ["postgresql-multi-node", "resilience-postgresql-multi-node-1-1"],
      ["sqlite-single-node", "resilience-sqlite-single-node-1-2"],
      ["postgresql-single-node", "resilience-postgresql-single-node-1-3"],
    ];
    if (fault === "omitted profile") entries.pop();
    await writeFile(
      join(directory, "profiles.tsv"),
      entries.map((row) => row.join("\t")).join("\n"),
    );
    if (fault !== "omitted profile") {
      const location = join(directory, entries[0][1]);
      await mkdir(location);
      for (const phase of [
        "prepare",
        "up",
        "exercise",
        "assert-profile",
        "profile",
      ])
        await writeFile(join(location, `${phase}.exit`), "0\n");
      await writeFile(
        join(location, "resilience-profile.json"),
        JSON.stringify({
          status: "passed",
          profile: entries[0][0],
          processes: [{ instanceId: "only-one-process" }],
        }),
      );
      for (const name of ["profile-duration", "exercise-controller"])
        await writeFile(join(location, `${name}.json`), "{}");
    }
    const result = spawnSync(
      process.execPath,
      ["tests/support/assert-resilience-profiles.mjs", directory, directory],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError/);
    await assert.rejects(access(join(directory, "resilience-profiles.json")));
  });
}
