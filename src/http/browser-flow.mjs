import { randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import {
  AuthorizationError,
  InvalidRequestError,
} from "@atproto/oauth-provider/errors";
import { page, escapeHtml } from "../ui/html.mjs";
import { hidden } from "../ui/forms.mjs";
import { resolveBrand } from "../ui/experience.js";
const FLOW_LIFETIME = 15 * 60_000;
const opaque = () => randomBytes(32).toString("base64url");
class ExpiredFlowError extends Error {
  constructor(flow, browser) {
    super("This sign-in has expired. Restart it to continue.");
    this.flow = flow;
    this.browser = browser;
    this.status = 410;
  }
}

export function createBrowserFlow({
  db,
  config,
  provider,
  redirectAuthorizationError,
}) {
  const origin = new URL(config.issuer).origin;
  const brandClients = {
    primary: `${new URL(config.clientUrl).origin}/client-metadata.json`,
    secondary: `${new URL(config.clientUrl).origin}/client-metadata-secondary.json`,
  };
  const pageForFlow = (res, title, body, flow, status = 200, policy = {}) =>
    page(
      res,
      title,
      body,
      status,
      policy,
      resolveBrand(flow?.clientId, brandClients),
    );
  const loadBrowser = async (req, res, rotate = false) => {
    const device = await provider.deviceManager.load(req, res, rotate);
    let browser = db.get("browser", device.deviceId);
    if (!browser) {
      browser = { csrf: opaque(), createdAt: new Date() };
      db.set("browser", device.deviceId, browser);
    }
    return { ...device, csrf: browser.csrf };
  };
  const checkCsrf = (req, browser) => {
    const a = Buffer.from(String(req.body?.csrf ?? ""));
    const b = Buffer.from(browser.csrf);
    if (
      req.headers.origin !== origin ||
      a.length !== b.length ||
      !timingSafeEqual(a, b)
    ) {
      throw new InvalidRequestError("Invalid form origin or CSRF token");
    }
  };
  const fields = (flow, browser) =>
    hidden("flow", flow.id) + hidden("csrf", browser.csrf);
  const save = (flow) => db.set("auth-flows", flow.id, flow);
  const newFlow = (browser, extra = {}) => {
    const flow = {
      id: opaque(),
      deviceId: browser.deviceId,
      createdAt: new Date(),
      ...extra,
    };
    save(flow);
    return flow;
  };
  const getFlow = async (req, res) => {
    const browser = await loadBrowser(req, res);
    checkCsrf(req, browser);
    const flow = db.get("auth-flows", String(req.body?.flow ?? ""));
    if (!flow || flow.deviceId !== browser.deviceId) {
      throw new InvalidRequestError(
        "This sign-in has expired. Start again from your application.",
      );
    }
    const createdAt = new Date(flow.createdAt).getTime();
    if (
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() ||
      Date.now() - createdAt > FLOW_LIFETIME
    )
      throw new ExpiredFlowError(flow, browser);
    if (flow.requestUri)
      await provider.requestManager.get(
        flow.requestUri,
        browser.deviceId,
        flow.clientId,
      );
    return { flow, browser };
  };
  const guarded = (fn) => async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (res.headersSent) return next(err);
      if (err instanceof AuthorizationError)
        return redirectAuthorizationError(res, err);
      if (err instanceof ExpiredFlowError) {
        const restartForm = err.flow.requestUri
          ? `<p>Your sign-in expired. Restart it to continue the same verified application request.</p><form method="post" action="/auth/restart">${fields(err.flow, err.browser)}<button>Restart sign-in</button></form>`
          : '<p>Your sign-in expired. Start again to request a new code.</p><a href="/login">Start a new sign-in</a>';
        return pageForFlow(res, "Sign-in expired", restartForm, err.flow, 410);
      }
      page(
        res,
        "Unable to continue",
        `<p role="alert">${escapeHtml(err.message)}</p><a href="/login">Start a new sign-in</a>`,
        err.status >= 400 && err.status < 600 ? err.status : 400,
      );
    }
  };
  const form = express.urlencoded({ extended: false, limit: "16kb" });

  return {
    loadBrowser,
    checkCsrf,
    fields,
    save,
    newFlow,
    getFlow,
    pageForFlow,
    guarded,
    form,
  };
}
export { FLOW_LIFETIME };
