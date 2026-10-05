import { escapeHtml } from "./html.mjs";
export const hidden = (name, value) =>
  `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
