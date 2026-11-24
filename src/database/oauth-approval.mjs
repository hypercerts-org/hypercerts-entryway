// These versions fence an approval across provider awaits and code consumption.
export async function approvalVersion(db, did, clientId) {
  return [
    (await db.get("oauth:grant-generations", did)) ?? null,
    (await db.get(
      "oauth:client-generations",
      JSON.stringify([did, clientId]),
    )) ?? null,
  ];
}
export async function invalidateClientApproval(db, did, clientId) {
  await db.set(
    "oauth:client-generations",
    JSON.stringify([did, clientId]),
    crypto.randomUUID(),
  );
}
export async function invalidateAccountApprovals(db, did) {
  await db.set("oauth:grant-generations", did, crypto.randomUUID());
}
export function sameApprovalVersion(left, right) {
  return (
    Array.isArray(left) &&
    left.length === 2 &&
    left[0] === right[0] &&
    left[1] === right[1]
  );
}
