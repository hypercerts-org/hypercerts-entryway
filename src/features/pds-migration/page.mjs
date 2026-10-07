import { escapeHtml as esc } from "../../ui/html.mjs";
import { hidden, form, stamp, section } from "../../ui/account-forms.mjs";

export function renderMigrationPanel({
  config,
  a,
  csrf,
  migrationState,
  migrationRecovery,
  migration,
}) {
  const destinations = config.pds.filter((pds) => pds.id !== a.pdsId);
  const migrationPending =
    migrationState && migrationState.phase !== "complete";
  const migrationTarget = migrationState
    ? config.pds.find((pds) => pds.id === migrationState.targetPdsId)
    : null;
  const recoveryRequired = migrationRecovery?.state === "dispatched";
  if (!migration) return "";
  let status = "";
  if (migrationState) {
    const target = esc(migrationTarget?.url ?? migrationState.targetPdsId);
    let description = `Last migration completed to ${target}.`;
    if (migrationPending) {
      const guidance = recoveryRequired
        ? "Contact the service operator; retrying alone cannot settle the uncertain server request."
        : "Continue the saved migration.";
      description = `Your migration to ${target} is unfinished. ${guidance} Keep repository writes paused until it completes.`;
    }
    status = `<p role="status">${description} Last updated ${esc(stamp(migrationState.updatedAt))}.</p>`;
  }
  let actions;
  if (migrationPending) {
    actions = recoveryRequired
      ? `<form method="post" action="/account/migration-confirm">${hidden("csrf", csrf)}${hidden("pdsId", migrationState.targetPdsId)}<button disabled>Waiting for operator recovery</button></form>`
      : form(
          "migration-confirm",
          csrf,
          hidden("pdsId", migrationState.targetPdsId),
          "Resume data server migration",
        );
  } else if (destinations.length) {
    const options = destinations
      .map(
        (pds) =>
          `<option value="${esc(pds.id)}">${esc(pds.id)} — ${esc(pds.url)}</option>`,
      )
      .join("");
    const destination = `<label>Destination data server<select name="pdsId" required>${options}</select></label>`;
    actions = form(
      "migration-request",
      csrf,
      destination,
      "Start data server migration",
    );
  } else {
    actions = "<p>No other data server is enrolled.</p>";
  }
  return section(
    "migration",
    "Move your data server",
    `<p>Move this account's repository and blobs to another enrolled data server while keeping its DID and handle. Writes pause during the transfer, and all browser and application sessions and app passwords are revoked. The old server retains a deactivated copy.</p>${status}${actions}`,
  );
}
