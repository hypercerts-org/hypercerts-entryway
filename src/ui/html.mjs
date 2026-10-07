import { DEFAULT_BRAND, renderExperiencePage } from "./experience.js";

export const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export function page(
  res,
  title,
  body,
  status = 200,
  policy = {},
  brand = DEFAULT_BRAND,
) {
  const rendered = renderExperiencePage({ title, body, brand, policy });
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": rendered.contentSecurityPolicy,
  });
  return res.status(status).type("html").send(rendered.html);
}
