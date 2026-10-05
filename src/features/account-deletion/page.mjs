import { field, form, section } from "../../ui/account-forms.mjs";

export function renderLifecyclePanel({ csrf, a, statusForm }) {
  const lifecycle = section(
    "lifecycle",
    "Account lifecycle",
    `
      <p>Deactivation pauses repository writes. Reactivation restores them. Deleting the account removes the repository and blobs; the DID history remains.</p>
      ${statusForm}
      ${form("delete", csrf, field("confirm", "Type your handle to delete this test account", "text", 'autocomplete="off"'), "Delete test account")}
    `,
  );
  return lifecycle;
}
