import { page, escapeHtml as esc } from "./html.mjs";

export const hidden = (name, value) =>
  `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
export const accountUrl = (did) => `/account?did=${encodeURIComponent(did)}`;
const accountContextFields = (context) =>
  context?.did ? hidden("did", context.did) : "";
const formAction = (action) =>
  action.startsWith("/") ? action : `/account/${action}`;
export const field = (name, label, type = "text", attributes = "") =>
  `<label>${esc(label)}<input name="${esc(name)}" type="${type}" ${attributes} required></label>`;
export const form = (
  action,
  csrf,
  contents,
  button,
  accountContext,
  extra = "",
) =>
  `<form method="post" action="${formAction(action)}" ${extra}>${hidden("csrf", csrf)}${accountContextFields(accountContext)}${contents}<button>${esc(button)}</button></form>`;
export const stamp = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "Unknown";
};
export const section = (id, title, contents) =>
  `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${esc(title)}</h2>${contents}</section>`;
export const rows = (items, render, empty) =>
  items.length
    ? `<ul class="settings-list">${items.map((item) => `<li>${render(item)}</li>`).join("")}</ul>`
    : `<p class="muted">${empty}</p>`;
export const nextStep = (
  res,
  { title, csrf, action, contents, button, message, accountContext },
) =>
  page(
    res,
    title,
    `<p role="status">${esc(message)}</p>${form(action, csrf, contents, button, accountContext)}<a href="${accountContext?.did ? accountUrl(accountContext.did) : "/account"}">Return to account settings</a>`,
  );
