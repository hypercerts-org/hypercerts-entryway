import { isIP } from "node:net";
import { readProtectedJson } from "../protected-json.js";

export async function loadPdsRegistryTargets(path) {
  if (path === undefined) return undefined;
  try {
    const input = await readProtectedJson(path, 65_536);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error();
    const targets = new Map();
    for (const [origin, addresses] of Object.entries(input)) {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !Array.isArray(addresses) ||
        !addresses.length ||
        addresses.length > 32 ||
        addresses.some(
          (address) => typeof address !== "string" || !isIP(address),
        )
      )
        throw Error();
      const literal = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) && !addresses.includes(literal)) throw Error();
      targets.set(origin, [...addresses]);
    }
    return targets;
  } catch {
    throw new Error("InvalidPdsRegistryTargets");
  }
}
