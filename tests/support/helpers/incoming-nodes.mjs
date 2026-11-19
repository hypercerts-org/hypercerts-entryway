import { expect } from "@playwright/test";

// Two-node routing for the incoming journey, used only by `./tests/local.sh
// fresh-group incoming-two-node`. The profile ingress in front of both Entryway
// nodes forwards a request to the node named in `x-profile-node` and balances
// the rest; every forwarded response carries the serving process's
// `x-entryway-instance` and leaves a receipt (`/__profile/receipts`) with the
// node, instance, path, status and whether the caller pinned it. Without an
// order (the single-node journey) every method is a pass-through.
//
// Pinned: XRPC calls made by the test, which add `headers(role)`, and browser
// pages, whose context routes every request to the issuer origin (navigations,
// their redirects and the OAuth SDK's own fetches) with the header added.
// Context-wide extra headers (as the resilience profile uses) stopped the
// SDK's cross-origin login before consent: the OAuth endpoints' preflight
// allows only Content-Type and DPoP. While a route is active Playwright
// answers CORS preflights itself, so real preflight handling is covered by the
// single-node journey, not by this run. A route sees only the first URL of a
// redirect chain, so a redirect from another origin into the issuer (the
// confidential client's authorization) is not routed; such a stage uses
// context-wide extra headers instead (`via: "headers"`), as the resilience
// profile does, and must contain no SDK fetches. Observed only: requests a PDS makes to
// Entryway on the client's behalf (the stock `activateAccount` forward), which
// the test cannot address; their receipts are unpinned and recorded as seen.

const noise = (path) =>
  path === "/_health" || path === "/_readyz" || path.startsWith("/__profile/");

const instanceOf = (response) =>
  typeof response.headers?.get === "function"
    ? response.headers.get("x-entryway-instance")
    : response.headers()["x-entryway-instance"];

export function nodeRouting(issuer, order) {
  const enabled = Array.isArray(order);
  const origin = new URL(issuer).origin;
  const ids = new Map();
  // One entry per stage: pinned stages name the node the test chose, observed
  // ones the node the ingress chose for the PDS's own request.
  const stages = [];
  let current;

  async function receipts() {
    const response = await fetch(new URL("/__profile/receipts", issuer), {
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status, "profile ingress receipts").toBe(200);
    const all = await response.json();
    expect(Array.isArray(all), "receipt list").toBe(true);
    return all;
  }
  async function mark() {
    return (await receipts()).at(-1)?.id ?? 0;
  }
  async function since(start) {
    const all = await receipts();
    // The ingress keeps a bounded window; the oldest kept receipt must not be
    // newer than the mark, or this stage's receipts were dropped.
    expect(
      all.length === 0 || all[0].id <= start + 1,
      "receipt window covers the stage",
    ).toBe(true);
    return all.filter(({ id, path }) => id > start && !noise(path));
  }

  return {
    enabled,
    stages,
    /** Reads both nodes' instance IDs; both ready and distinct processes. */
    async load() {
      if (!enabled) return;
      expect(new Set(order).size, "two distinct node roles").toBe(2);
      const topology = await (
        await fetch(new URL("/__profile/nodes", issuer))
      ).json();
      expect(topology.nodes.map(({ node }) => node).sort()).toEqual(
        order.toSorted(),
      );
      expect(topology.nodes.every(({ ready }) => ready)).toBe(true);
      for (const { node, instanceId } of topology.nodes)
        ids.set(node, instanceId);
      expect(new Set(ids.values()).size, "distinct instance IDs").toBe(2);
    },
    /** Request headers pinning a call to the role's node. */
    headers(role) {
      return enabled ? { "x-profile-node": order[role] } : {};
    },
    /** The response came from the current stage's node. */
    expectServed(response, what) {
      if (!enabled) return;
      expect(current, `${what} inside a pinned stage`).toBeDefined();
      expect(instanceOf(response), `${what} served by ${current.node}`).toBe(
        current.instanceId,
      );
    },
    /**
     * Runs one Entryway-facing stage on the role's node. With `page`, the
     * browser context pins every issuer request (by route, or with `via:
     * "headers"` by context-wide extra headers) and every issuer response it
     * sees must come from that node. Afterwards every pinned receipt in the window must
     * name that node, and unpinned ones (requests the test did not address)
     * are kept as observations.
     */
    async stage(name, role, did, action, { page, via = "route" } = {}) {
      if (!enabled) return action();
      const node = order[role];
      current = { node, instanceId: ids.get(node) };
      const start = await mark();
      const responses = [];
      const collect = (response) => {
        if (
          new URL(response.url()).origin === origin &&
          response.request().method() !== "OPTIONS"
        )
          responses.push(response);
      };
      const pattern = `${origin}/**`;
      const pin = (route) =>
        route.continue({
          headers: { ...route.request().headers(), "x-profile-node": node },
        });
      if (page) {
        if (via === "headers")
          await page.context().setExtraHTTPHeaders(this.headers(role));
        else await page.context().route(pattern, pin);
        page.context().on("response", collect);
      }
      let result;
      try {
        result = await action();
      } finally {
        if (page) {
          page.context().off("response", collect);
          if (via === "headers") await page.context().setExtraHTTPHeaders({});
          else await page.context().unroute(pattern, pin);
        }
      }
      for (const response of responses)
        expect(
          instanceOf(response),
          `${name}: ${new URL(response.url()).pathname} served by ${node}`,
        ).toBe(current.instanceId);
      const seen = await since(start);
      const pinned = seen.filter((receipt) => receipt.pinned);
      expect(pinned.length, `${name}: pinned receipts`).toBeGreaterThan(0);
      for (const receipt of pinned)
        expect(
          { node: receipt.node, instanceId: receipt.instanceId },
          `${name}: ${receipt.method} ${receipt.path}`,
        ).toEqual(current);
      stages.push({
        stage: name,
        pinned: true,
        node,
        instanceId: current.instanceId,
        did,
        requests: pinned.length,
        browserResponses: responses.length,
        unpinned: seen
          .filter((receipt) => !receipt.pinned)
          .map(({ method, path, node, instanceId, status }) => ({
            method,
            path,
            node,
            instanceId,
            status,
          })),
      });
      current = undefined;
      return result;
    },
    /**
     * Runs a step whose Entryway request a PDS makes, so the test cannot pin
     * it. Records which node the ingress chose for each unpinned receipt on
     * `path`; at least one must exist, or the forward was not observed.
     */
    async observe(name, did, path, action) {
      if (!enabled) return action();
      const start = await mark();
      const result = await action();
      const seen = (await since(start)).filter(
        (receipt) => !receipt.pinned && receipt.path === path,
      );
      expect(seen.length, `${name}: unpinned ${path} receipt`).toBeGreaterThan(
        0,
      );
      for (const receipt of seen) {
        expect([...ids.values()]).toContain(receipt.instanceId);
        stages.push({
          stage: name,
          pinned: false,
          node: receipt.node,
          instanceId: receipt.instanceId,
          did,
          method: receipt.method,
          path: receipt.path,
          status: receipt.status,
        });
      }
      return result;
    },
    /**
     * Consecutive pinned stages in `names` ran on different instances for one
     * DID. Observed stages are reported, not part of the alternation.
     */
    expectAlternation(names, did) {
      const pinned = stages.filter(
        (stage) => stage.pinned && names.includes(stage.stage),
      );
      expect(pinned.map(({ stage }) => stage)).toEqual(names);
      for (const stage of pinned) expect(stage.did, stage.stage).toBe(did);
      for (let index = 1; index < pinned.length; index++)
        expect(
          pinned[index].instanceId,
          `${pinned[index - 1].stage} then ${pinned[index].stage}`,
        ).not.toBe(pinned[index - 1].instanceId);
    },
    /** The stage table, with node names, instance IDs and paths only. */
    report() {
      return { order, instances: Object.fromEntries(ids), stages };
    },
  };
}
