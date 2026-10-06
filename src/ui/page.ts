import { DEFAULT_BRAND } from "./branding.js";
import type { BrandTokens, PagePolicy } from "./branding-types.js";

export interface PageInput {
  title: string;
  body: string;
  brand?: BrandTokens;
  policy?: PagePolicy;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

export function renderExperiencePage({
  title,
  body,
  brand = DEFAULT_BRAND,
  policy = {},
}: PageInput): { html: string; contentSecurityPolicy: string } {
  const style = `:root{color-scheme:light;--page:${brand.page};--surface:${brand.surface};--text:${brand.text};--muted:${brand.muted};--border:${brand.border};--accent:${brand.accent};--accent-text:${brand.accentText};--focus:${brand.focus}}*{box-sizing:border-box}body{font:17px/1.5 system-ui,sans-serif;background:var(--page);color:var(--text);margin:0}main{width:min(960px,calc(100% - 32px));margin:clamp(20px,6vh,64px) auto;padding:clamp(20px,4vw,40px);background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 12px 36px #10251a12}h1{font-size:clamp(1.65rem,4vw,2.1rem);line-height:1.2;margin:.65rem 0 1.3rem}h2{font-size:1.35rem}label{display:block;margin:18px 0 7px;font-weight:600}input,select,button{font:inherit;box-sizing:border-box;padding:12px 14px;border-radius:8px;border:1px solid var(--border)}input,select{width:100%;min-height:48px;background:white;color:var(--text)}button{margin-top:14px;background:var(--accent);color:var(--accent-text);cursor:pointer;min-height:48px;font-weight:650}button.secondary{background:var(--surface);color:var(--accent)}button:hover{filter:brightness(.94)}:focus-visible{outline:3px solid var(--focus);outline-offset:3px}small,.muted{color:var(--muted)}code{overflow-wrap:anywhere}form{margin-bottom:14px}a{color:var(--accent);text-decoration-thickness:.08em;text-underline-offset:.15em}a:hover{text-decoration-thickness:.13em}section{padding:20px 0;border-top:1px solid var(--border)}section:first-child{border-top:0}.account,.settings-list,.account-context{padding:16px;background:color-mix(in srgb,var(--page) 68%,white);border-radius:10px}.account-context{display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;margin:20px 0}.account-context strong{font-size:1.08rem}.account-context span{overflow-wrap:anywhere}.identity{display:grid;grid-template-columns:minmax(120px,180px) 1fr;gap:10px}.identity dt{color:var(--muted)}.identity dd{margin:0;overflow-wrap:anywhere}.section-nav{display:flex;flex-wrap:wrap;gap:12px 20px;margin:22px 0}.settings-list{list-style:none;padding:0}.settings-list li{padding:14px;border-bottom:1px solid var(--border);overflow-wrap:anywhere}.settings-list li:last-child{border-bottom:0}.settings-list span{display:block;font-size:14px;margin-top:6px}.check input{width:auto;margin-right:10px}[role=alert]{padding:12px;border-left:4px solid #a52828;background:#fff1f0;color:#681b1b;border-radius:4px}button:disabled{opacity:.65;cursor:wait}@media(max-width:600px){body{font-size:16px}main{width:100%;margin:0;padding:20px 16px;border-radius:0;min-height:100dvh;border-left:0;border-right:0}.account-context{grid-template-columns:1fr}.identity{grid-template-columns:1fr}.identity dd{margin-bottom:10px}.settings-list li{padding:12px 8px}}`;
  const formOrigin = policy.formOrigin
    ? ` ${escapeHtml(policy.formOrigin)}`
    : "";
  const script = policy.scriptNonce
    ? `script-src 'nonce-${escapeHtml(policy.scriptNonce)}'; `
    : "";
  const contentSecurityPolicy = `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formOrigin}; ${script}frame-ancestors 'none'; base-uri 'none'`;
  return {
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="${brand.page}"><title>${escapeHtml(title)} · ${escapeHtml(brand.name)}</title><style>${style}</style></head><body><main><small>${brand.id === "entryway" ? "Entryway account service" : `${escapeHtml(brand.name)} · Entryway`}</small><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    contentSecurityPolicy,
  };
}
