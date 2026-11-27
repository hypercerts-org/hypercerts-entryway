import { chmod, copyFile, readFile, stat } from "node:fs/promises";

// Try every independent backup even when an earlier restore fails. Never expose
// filesystem errors: paths and configuration contents are private to the sandbox.
export async function restoreAuthorityFiles(paths, run) {
  let failed = false;
  for (const path of paths) {
    try {
      const backup = `${path}.verification-${run}`;
      await copyFile(backup, path);
      await chmod(path, 0o600);
      const [expected, actual, info] = await Promise.all([
        readFile(backup),
        readFile(path),
        stat(path),
      ]);
      if (!expected.equals(actual) || (info.mode & 0o7777) !== 0o600)
        throw new Error("verification failed");
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Sandbox authority restoration failed");
}
