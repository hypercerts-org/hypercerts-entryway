// Run through the managed tooling container. Every export starts from no state.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const check = process.argv.includes("--check");
await mkdir(".runtime", { recursive: true });
const temporary = await mkdtemp(resolve(".runtime/schema-export-"));
try {
  for (const backend of ["sqlite", "postgresql"]) {
    const output = join(temporary, backend);
    const generated = spawnSync(
      "node_modules/.bin/drizzle-kit",
      ["generate", `--config=drizzle.${backend}.config.ts`],
      {
        stdio: "inherit",
        env: { ...process.env, DRIZZLE_EXPORT_DIRECTORY: output },
      },
    );
    if (generated.status !== 0) throw Error(`SchemaExportFailed:${backend}`);
    const paths = (await readdir(output, { recursive: true })).filter((path) =>
      path.endsWith(".sql"),
    );
    if (paths.length !== 1)
      throw Error(`UnexpectedFreshSchemaCount:${backend}`);
    const sql = await readFile(join(output, paths[0]), "utf8");
    const target = `src/database/schema/${backend}.sql`;
    if (check) {
      if (sql !== (await readFile(target, "utf8")))
        throw Error(`SchemaAssetMismatch:${backend}`);
    } else await writeFile(target, sql);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
