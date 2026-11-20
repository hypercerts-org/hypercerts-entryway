import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Two-node routing for the incoming journey, used only by `./tests/local.sh
// fresh-group incoming-two-node`. The profile ingress in front of both Entryway
// nodes forwards a request to the node named in `x-profile-node` and balances
// the rest; every forwarded response carries the serving process's
// `x-entryway-instance` and leaves a receipt (`/__profile/receipts`) with the
// node, instance, path, status, whether the caller pinned it and the caller's
// `x-profile-stage` tag, which the ingress strips before forwarding. Without
// an order (the single-node journey) every method is a pass-through.
//
// Pinned: XRPC calls made by the test, which add `headers(role)`, and browser
// pages, whose context routes every request to the issuer origin (navigations,
// their redirects and the OAuth SDK's own fetches) with the headers added.
// Every pinned request carries its stage's tag, and a stage is checked against
// the receipts with its tag and the browser requests started inside it, so a
// response that arrives after the next stage began is never attributed to it.
// Context-wide extra headers (as the resilience profile uses) stopped the
// SDK's cross-origin login before consent: the OAuth endpoints' preflight
// allows only Content-Type and DPoP. While any route is active Playwright
// answers every intercepted CORS preflight itself, so no route stage exercises
// a real preflight. A route sees only the first URL of a redirect chain, so a
// redirect from another origin into the issuer (the confidential client's
// authorization) is not routed; such a stage uses context-wide extra headers
// instead (`via: "headers"`), as the resilience profile does, and fails if it
// makes any scripted (fetch or XHR) issuer request. Observed only: requests a
// PDS makes to Entryway on the client's behalf (the stock `activateAccount`
// forward), which the test cannot address; their receipts are unpinned and
// recorded as seen.

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
  // Tags are unique per routing instance, so the second node order (another
  // project on the same ingress) cannot match the first order's receipts.
  const run = randomUUID().slice(0, 8);
  let tags = 0;
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
  const describe = ({ method, path, node, instanceId, status }) => ({
    method,
    path,
    node,
    instanceId,
    status,
  });

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
      const byName = (a, b) => a.localeCompare(b);
      expect(topology.nodes.map(({ node }) => node).toSorted(byName)).toEqual(
        order.toSorted(byName),
      );
      expect(topology.nodes.every(({ ready }) => ready)).toBe(true);
      for (const { node, instanceId } of topology.nodes)
        ids.set(node, instanceId);
      expect(new Set(ids.values()).size, "distinct instance IDs").toBe(2);
    },
    /** Request headers pinning a call to the role's node and current stage. */
    headers(role) {
      if (!enabled) return {};
      return {
        "x-profile-node": order[role],
        ...(current ? { "x-profile-stage": current.tag } : {}),
      };
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
     * "headers"` by context-wide extra headers) and every issuer response to a
     * request started inside the stage must come from that node. Afterwards
     * every receipt carrying the stage's tag must be pinned to that node, and
     * unpinned ones in the stage's window (requests the test did not address)
     * are kept as observations. The stage is recorded before it is checked,
     * so a failing run still reports it.
     */
    async stage(name, role, did, action, { page, via = "route" } = {}) {
      if (!enabled) return action();
      const node = order[role];
      const expected = { node, instanceId: ids.get(node) };
      const tag = `${run}-${++tags}`;
      current = { ...expected, tag };
      const start = await mark();
      const started = new Set();
      const responses = [];
      const track = (request) => {
        if (new URL(request.url()).origin === origin) started.add(request);
      };
      const collect = (response) => {
        if (
          started.has(response.request()) &&
          response.request().method() !== "OPTIONS"
        )
          responses.push(response);
      };
      const pattern = `${origin}/**`;
      const pin = (route) =>
        route.continue({
          headers: {
            ...route.request().headers(),
            "x-profile-node": node,
            "x-profile-stage": tag,
          },
        });
      if (page) {
        page.context().on("request", track);
        page.context().on("response", collect);
        if (via === "headers")
          await page.context().setExtraHTTPHeaders(this.headers(role));
        else await page.context().route(pattern, pin);
      }
      let result;
      try {
        result = await action();
      } finally {
        current = undefined;
        if (page) {
          if (via === "headers") await page.context().setExtraHTTPHeaders({});
          else await page.context().unroute(pattern, pin);
          page.context().off("request", track);
          page.context().off("response", collect);
        }
      }
      const seen = await since(start);
      const tagged = seen.filter((receipt) => receipt.stage === tag);
      const record = {
        stage: name,
        pinned: true,
        node,
        instanceId: expected.instanceId,
        // Instance IDs that actually answered this stage: its tagged receipts
        // and the issuer responses its browser requests received.
        observed: [
          ...new Set([
            ...tagged.map(({ instanceId }) => instanceId),
            ...responses.map(instanceOf),
          ]),
        ],
        did,
        requests: tagged.length,
        browserResponses: responses.length,
        unpinned: seen.filter((receipt) => !receipt.pinned).map(describe),
        // Pinned receipts that landed in this window for another stage (a
        // response that arrived late) or without a tag: reported, not judged.
        other: seen
          .filter((receipt) => receipt.pinned && receipt.stage !== tag)
          .map(describe),
      };
      stages.push(record);
      if (via === "headers")
        expect(
          [...started]
            .filter((request) =>
              ["fetch", "xhr"].includes(request.resourceType()),
            )
            .map(
              (request) =>
                `${request.method()} ${new URL(request.url()).pathname}`,
            ),
          `${name}: no scripted issuer requests under context-wide headers`,
        ).toEqual([]);
      for (const response of responses)
        expect(
          instanceOf(response),
          `${name}: ${new URL(response.url()).pathname} served by ${node}`,
        ).toBe(expected.instanceId);
      expect(tagged.length, `${name}: tagged receipts`).toBeGreaterThan(0);
      for (const receipt of tagged)
        expect(
          {
            pinned: receipt.pinned,
            node: receipt.node,
            instanceId: receipt.instanceId,
          },
          `${name}: ${receipt.method} ${receipt.path}`,
        ).toEqual({ pinned: true, ...expected });
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
        stages.push({ stage: name, pinned: false, did, ...describe(receipt) });
      }
      return result;
    },
    /**
     * Consecutive pinned stages in `names` were answered by different
     * instances for one DID, judged on the instance IDs each stage observed
     * (receipts and response headers), not on the configured order. Each
     * stage must have observed exactly one instance. Observed-only stages are
     * reported, not part of the alternation.
     */
    expectAlternation(names, did) {
      const pinned = stages.filter(
        (stage) => stage.pinned && names.includes(stage.stage),
      );
      expect(pinned.map(({ stage }) => stage)).toEqual(names);
      for (const stage of pinned) {
        expect(stage.did, stage.stage).toBe(did);
        expect(stage.observed, `${stage.stage}: one observed instance`).toEqual(
          [expect.any(String)],
        );
      }
      for (let index = 1; index < pinned.length; index++)
        expect(
          pinned[index].observed[0],
          `${pinned[index - 1].stage} then ${pinned[index].stage}`,
        ).not.toBe(pinned[index - 1].observed[0]);
    },
    /** The stage table, with node names, instance IDs and paths only. */
    report() {
      return { order, instances: Object.fromEntries(ids), stages };
    },
  };
}
