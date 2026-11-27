import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Reads one protected regular file, including orchestrator symlink mounts. */
export async function readProtectedJson(
  path: string,
  maximumBytes: number,
): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > maximumBytes)
      throw new Error("InvalidProtectedFile");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > maximumBytes) throw new Error("InvalidProtectedFile");
    return JSON.parse(buffer.subarray(0, used).toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}
