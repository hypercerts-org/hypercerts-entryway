import { readProtectedJson } from "../protected-json.js";
import { validateMailAddress } from "./templates.js";
export interface PdsHealthContacts {
  fleet?: string;
  hosts: Record<string, string>;
}
export async function loadPdsHealthContacts(
  path: string | undefined,
): Promise<PdsHealthContacts> {
  if (path === undefined) return { hosts: {} };
  try {
    const raw = await readProtectedJson(path, 65_536);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error();
    const input = raw as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !["fleet", "hosts"].includes(key)) ||
      (input.fleet !== undefined && typeof input.fleet !== "string") ||
      (input.hosts !== undefined &&
        (!input.hosts ||
          typeof input.hosts !== "object" ||
          Array.isArray(input.hosts)))
    )
      throw Error();
    const hosts: Record<string, string> = Object.create(null);
    for (const [id, value] of Object.entries(
      (input.hosts ?? {}) as Record<string, unknown>,
    )) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ||
        typeof value !== "string"
      )
        throw Error();
      hosts[id] = validateMailAddress(value);
    }
    return {
      ...(typeof input.fleet === "string"
        ? { fleet: validateMailAddress(input.fleet) }
        : {}),
      hosts,
    };
  } catch {
    throw new Error("InvalidPdsHealthContacts");
  }
}
