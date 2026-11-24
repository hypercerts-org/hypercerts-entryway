import { renderFlowError } from "#entryway-ssr/ui";
import { randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import {
  AuthorizationError,
  InvalidRequestError,
} from "@atproto/oauth-provider/errors";
import { page } from "../ui/html.mjs";
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

export class ChangedFlowIntentError extends Error {
  constructor(flow, browser) {
    super(
      "This sign-in changed while the code was checked. Use the latest code sent to the email below.",
    );
    this.flow = flow;
    this.browser = browser;
    this.status = 400;
  }
}

const SAFE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?$/i;

// The CSP form-action source for a redirect_uri, or undefined. A redirect_uri
// that passes URI validation can still break CSP syntax (a wildcard host, or a
// ";" that starts another directive), so only a strict source reaches the header.
function formActionSource(redirectUri) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:" || url.protocol === "http:")
    return SAFE_HOST.test(url.host)
      ? `${url.protocol}//${url.host}`
      : undefined;
  // A private-use scheme (RFC 8252: a reverse domain name, so it has a dot)
  // names no host, so the whole scheme is the source.
  return url.host === "" && url.protocol.includes(".")
    ? url.protocol
    : undefined;
}

// An OAuth flow ends at the client's redirect_uri, and the form-action policy
// applies to that redirect after a form POST. Every page of an authorization
// flow therefore allows the client's origin; a standalone flow does not.
function clientFormPolicy(flow) {
  const source = flow?.requestUri
    ? formActionSource(flow.parameters?.redirect_uri)
    : undefined;
  return source ? { formOrigin: source } : {};
}

export function createBrowserFlow({
  db,
  config,
  provider,
  redirectAuthorizationError,
  stores,
}) {
  const origin = new URL(config.issuer).origin;
  const brandClients = {
    primary: `${new URL(config.clientUrl).origin}/client-metadata.json`,
    secondary: `${new URL(config.clientUrl).origin}/client-metadata-secondary.json`,
  };
  const pageForFlow = (res, title, body, flow, status = 200) =>
    page(
      res,
      title,
      body,
      status,
      {
        ...clientFormPolicy(flow),
        layout: flow?.requestUri ? "oauth" : "standalone",
      },
      resolveBrand(flow?.clientId, brandClients),
    );
  const loadBrowser = async (req, res, rotate = false) => {
    const device = await provider.deviceManager.load(req, res, rotate);
    let browser = await db.get("browser", device.deviceId);
    if (!browser) {
      browser = { csrf: opaque(), createdAt: new Date() };
      await db.set("browser", device.deviceId, browser);
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
  const save = async (flow) => await db.set("auth-flows", flow.id, flow);
  const newFlow = async (browser, extra = {}) => {
    const flow = {
      id: opaque(),
      deviceId: browser.deviceId,
      createdAt: new Date(),
      ...extra,
    };
    await save(flow);
    return flow;
  };
  // Call within the transaction that validates the current attempt.
  const replaceFlow = async (current, browser, extra = {}, restart = false) => {
    const next = await newFlow(browser, {
      ...(restart ? {} : { createdAt: current.createdAt }),
      requestUri: current.requestUri,
      requestRecordId: current.requestRecordId,
      requestOwner: current.requestOwner,
      clientId: current.clientId,
      clientName: current.clientName,
      parameters: current.parameters,
      accountHint: current.accountHint,
      otpRequestCount: current.otpRequestCount,
      lastOtpSentAt: current.lastOtpSentAt,
      ...extra,
    });
    if (next.requestRecordId)
      await stores.setAuthorizationFlow(next, current.id);
    await db.delete("auth-flows", current.id);
    return next;
  };
  const readFlow = async (id, browser) => {
    const flow = await db.get("auth-flows", String(id ?? ""));
    if (!flow || flow.deviceId !== browser.deviceId) {
      throw new InvalidRequestError(
        "This sign-in has expired. Start again from your application.",
      );
    }
    if (flow.requestRecordId) await stores.assertAuthorizationFlow(flow);
    const createdAt = new Date(flow.createdAt).getTime();
    if (
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() ||
      Date.now() - createdAt > FLOW_LIFETIME
    )
      throw new ExpiredFlowError(flow, browser);
    return flow;
  };
  const refreshFlow = (flow, browser) => readFlow(flow.id, browser);
  // Call inside the transaction that applies the authentication result. Return
  // the current record, including deleted optional fields, never a merged snapshot.
  const readCurrentIntent = async (expected, browser) => {
    const current = await readFlow(expected.id, browser);
    if (
      current.email !== expected.email ||
      current.otpRequestCount !== expected.otpRequestCount ||
      current.lastOtpSentAt !== expected.lastOtpSentAt
    )
      throw new ChangedFlowIntentError(current, browser);
    return current;
  };
  const runRequest = (flow, operation) =>
    flow.requestRecordId
      ? stores.runAuthorizationFlow(flow, operation)
      : operation();
  const request = (flow, browser) =>
    runRequest(flow, () =>
      provider.requestManager.get(
        flow.requestUri,
        browser.deviceId,
        flow.clientId,
      ),
    );
  const getFlow = async (req, res) => {
    const browser = await loadBrowser(req, res);
    checkCsrf(req, browser);
    const flow = await readFlow(req.body?.flow, browser);
    if (flow.requestUri) await request(flow, browser);
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
        const restart = err.flow.requestUri
          ? { flow: err.flow.id, csrf: err.browser.csrf }
          : undefined;
        const message = restart
          ? "Your sign-in expired. Restart it to continue the same verified application request."
          : "Your sign-in expired. Start again to request a new code.";
        return pageForFlow(
          res,
          "Sign-in expired",
          renderFlowError({ message, ...(restart ? { restart } : {}) }).body,
          err.flow,
          410,
        );
      }
      page(
        res,
        "Unable to continue",
        renderFlowError({ message: err.message }).body,
        err.status >= 400 && err.status < 600 ? err.status : 400,
        { layout: "standalone" },
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
    replaceFlow,
    async bindFlow(flow, previousId) {
      if (flow.requestRecordId)
        await stores.setAuthorizationFlow(flow, previousId);
    },
    getFlow,
    refreshFlow,
    readFlow,
    request,
    runRequest,
    readCurrentIntent,
    pageForFlow,
    guarded,
    form,
  };
}
export { FLOW_LIFETIME };
