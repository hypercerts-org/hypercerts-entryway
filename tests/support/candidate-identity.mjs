import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
export function candidateIdentity() {
  const files = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    ".dockerignore",
    "drizzle.sqlite.config.ts",
    "drizzle.postgresql.config.ts",
  ];
  const excluded = new Set([
    ".git",
    ".runtime",
    "node_modules",
    "artifacts",
    "test-results",
    "playwright-report",
    "reports",
    "coverage",
  ]);
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (excluded.has(entry.name) || entry.name.startsWith(".sandbox"))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  // Include extensionless image inputs, controllers, fixtures, browser tests,
  // generated runtime SQL and schema export/copy inputs. Never walk state roots.
  for (const root of ["src", "dist/src", "scripts", "tests"]) walk(root);
  const manifest = files.sort().map((path) => ({
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));
  return {
    digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    files: manifest,
  };
}
