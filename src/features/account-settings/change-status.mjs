import { HttpError } from "../../http/http-error.mjs";

export function createStatusChange({
  get,
  save,
  journal,
  serialized,
  assertNoMigration,
  admin,
}) {
  const setStatus = (did, status, { deleteAfter } = {}) =>
    serialized(did, async () => {
      assertNoMigration(did);
      const row = get(did);
      if (!row || row.status === "deleted")
        throw new HttpError(404, "AccountNotFound", "Account not found");
      if (!["active", "deactivated"].includes(status))
        throw new HttpError(400, "InvalidStatus", "Invalid status");
      if (deleteAfter && !Number.isFinite(Date.parse(deleteAfter)))
        throw new HttpError(
          400,
          "InvalidRequest",
          "Invalid deletion timestamp",
        );
      const op = {
        id: `status:${did}`,
        kind: "status",
        did,
        status,
        deleteAfter,
        phase: "pds-pending",
        at: new Date(),
      };
      journal(op);
      await admin(row, "com.atproto.admin.updateSubjectStatus", {
        subject: { $type: "com.atproto.admin.defs#repoRef", did },
        deactivated: { applied: status === "deactivated" },
      });
      row.status = status;
      row.deleteAfter = status === "deactivated" ? deleteAfter : undefined;
      save(row);
      journal({ ...op, phase: "complete" });
      return row;
    });
  return setStatus;
}
