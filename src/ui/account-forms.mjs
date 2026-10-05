import { page, escapeHtml as esc } from "./html.mjs";

export const hidden = (name, value) =>
  `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
export const field = (name, label, type = "text", attributes = "") =>
  `<label>${esc(label)}<input name="${esc(name)}" type="${type}" ${attributes} required></label>`;
export const form = (action, csrf, contents, button, extra = "") =>
  `<form method="post" action="${action.startsWith("/") ? action : `/account/${action}`}" ${extra}>${hidden("csrf", csrf)}${contents}<button>${esc(button)}</button></form>`;
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
export const nextStep = (res, title, csrf, action, contents, button, message) =>
  page(
    res,
    title,
    `<p role="status">${esc(message)}</p>${form(action, csrf, contents, button)}<a href="/account">Return to account settings</a>`,
  );
