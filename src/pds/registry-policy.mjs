import { pdsVerifierPolicy } from "./registry-targets.mjs";

/** Authorize an exact saved host against the current consumed policy. */
export async function authorizeRegistryTarget(placement, verifier, host) {
  const authorized = await placement.resolveAuthenticated(
    host.id,
    host.revision,
    (revision) => pdsVerifierPolicy(revision, verifier),
  );
  if (
    !authorized ||
    authorized.url !== host.url ||
    authorized.internalUrl !== host.internalUrl ||
    (host.did !== undefined && authorized.did !== host.did)
  )
    throw Object.assign(new Error("PdsVerifierPolicyConflict"), {
      code: "PdsVerifierPolicyConflict",
    });
  return authorized;
}

/** Hold the database authority lock across policy validation and marker creation. */
export function authorizeRegistryAttempt(db, placement, verifier, host) {
  return async (_claim, descriptor, begin) =>
    db.transact(async () => {
      const authorized = await authorizeRegistryTarget(
        placement,
        verifier,
        host,
      );
      if (
        descriptor.target !== authorized.url &&
        descriptor.target !== authorized.internalUrl
      )
        throw Object.assign(new Error("PdsVerifierPolicyConflict"), {
          code: "PdsVerifierPolicyConflict",
        });
      return begin();
    });
}
