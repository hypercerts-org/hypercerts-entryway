import { escapeHtml as esc } from "../../ui/html.mjs";
import { field, form } from "../../ui/account-forms.mjs";

export const renderHandleForm = ({ csrf, a }) =>
  form(
    "handle",
    csrf,
    field(
      "handle",
      "New handle",
      "text",
      `value="${esc(a.handle)}" maxlength="253"`,
    ),
    "Update handle",
  );
