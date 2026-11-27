// Test-only coordination for one managed destination createAccount request.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const createPath = "/xrpc/com.atproto.server.createAccount";

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error("Managed create barrier timed out");
    await sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }
}

// The owner must keep the directory private and dispose it after the request settles.
export async function createManagedCreateBarrier({ timeoutMs = 30_000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "managed-create-barrier-"));
  return {
    directory,
    reached: () => waitForFile(join(directory, "reached"), timeoutMs),
    release: () => writeFile(join(directory, "release"), "", { flag: "wx" }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function managedCreateBarrierFetch({
  fetch,
  origin,
  directory,
  timeoutMs = 30_000,
}) {
  const expectedOrigin = new URL(origin);
  if (expectedOrigin.origin !== origin)
    throw new Error("Expected an exact origin");
  let armed = true;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      armed &&
      url.origin === origin &&
      url.pathname === createPath &&
      method === "POST"
    ) {
      armed = false;
      await writeFile(join(directory, "reached"), "", { flag: "wx" });
      await waitForFile(join(directory, "release"), timeoutMs);
    }
    return fetch(input, init);
  };
}
