import { escapeHtml as esc } from "../../ui/html.mjs";
import { hidden, form, stamp, section } from "../../ui/account-forms.mjs";

export function renderMigrationPanel({
  config,
  a,
  csrf,
  migrationState,
  migration,
}) {
  const destinations = config.pds.filter((pds) => pds.id !== a.pdsId);
  const migrationPending =
    migrationState && migrationState.phase !== "complete";
  const migrationTarget = migrationState
    ? config.pds.find((pds) => pds.id === migrationState.targetPdsId)
    : null;
  const migrationPanel = migration
    ? section(
        "migration",
        "Move your data server",
        `<p>Move this account's repository and blobs to another enrolled data server while keeping its DID and handle. Writes pause during the transfer, and all browser and application sessions and app passwords are revoked. The old server retains a deactivated copy.</p>${migrationState ? `<p role="status">${migrationPending ? `Your migration to ${esc(migrationTarget?.url ?? migrationState.targetPdsId)} is unfinished. Sign in again before resuming; keep repository writes paused until it completes.` : `Last migration completed to ${esc(migrationTarget?.url ?? migrationState.targetPdsId)}.`} Last updated ${esc(stamp(migrationState.updatedAt))}.</p>` : ""}${migrationPending ? form("migration-confirm", csrf, hidden("pdsId", migrationState.targetPdsId), "Resume data server migration") : destinations.length ? form("migration-request", csrf, `<label>Destination data server<select name="pdsId" required>${destinations.map((pds) => `<option value="${esc(pds.id)}">${esc(pds.id)} — ${esc(pds.url)}</option>`).join("")}</select></label>`, "Start data server migration") : "<p>No other data server is enrolled.</p>"}`,
      )
    : "";
  return migrationPanel;
}
