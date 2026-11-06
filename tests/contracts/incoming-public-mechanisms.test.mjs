import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as plc from "@did-plc/lib";
import {
  MemoryBlockstore,
  def,
  ensureV3Commit,
  readCarWithRoot,
  verifyCommitSig,
  verifyRepoCar,
} from "@atproto/repo";
import { parseStockPlcMessage } from "../support/helpers/stock-plc-mailpit.mjs";
import {
  ResponseStatusError,
  createIncomingPublicIo,
  runHeldStreamedCall,
} from "../support/helpers/incoming-public-io.mjs";

const requestTimeoutMs = 15_000;
const settleTimeoutMs = 5_000;
const carLimitBytes = 4 * 1024 * 1024;
const preflightBudgetMs = 30_000;
const exportBudgetMs = 30_000;
const destinationBudgetMs = 60_000;
const reservationBudgetMs = 20_000;

const within = async (signal, limitMs) =>
  Promise.race([
    new Promise((resolve) =>
      signal.addEventListener(
        "abort",
        () => resolve({ error: signal.reason }),
        { once: true },
      ),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ pending: true }), limitMs),
    ),
  ]);

const assertBudgetDeadline = (deadlineMs) => {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
    throw new RangeError("Invalid phase budget");
};

const createPhaseBudget = (t, { deadlineMs }) => {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
    throw new RangeError("Invalid phase budget");
  if (!t.signal) throw new TypeError("A node test signal is required");
  const expired = new Error("Phase budget exhausted");
  const controller = new AbortController();
  const timers = new Set();
  const children = new Set();
  const expire = () => {
    if (!controller.signal.aborted) controller.abort(expired);
  };
  const timer = setTimeout(expire, deadlineMs);
  timers.add(timer);
  const signal = AbortSignal.any([t.signal, controller.signal]);
  const onParentAbort = () => {
    for (const child of children) child.controller.abort(t.signal.reason);
  };
  t.signal.addEventListener("abort", onParentAbort, { once: true });
  const child = ({ deadlineMs: childBudgetMs } = {}) => {
    if (controller.signal.aborted) throw new Error("Phase budget exhausted");
    if (childBudgetMs !== undefined) assertBudgetDeadline(childBudgetMs);
    const childController = new AbortController();
    const childTimer =
      childBudgetMs === undefined
        ? undefined
        : setTimeout(() => childController.abort(expired), childBudgetMs);
    if (childTimer !== undefined) timers.add(childTimer);
    const entry = { controller: childController, timer: childTimer };
    children.add(entry);
    const childSignal = AbortSignal.any([
      t.signal,
      controller.signal,
      childController.signal,
    ]);
    const finish = () => {
      children.delete(entry);
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
        timers.delete(entry.timer);
      }
    };
    childSignal.addEventListener("abort", finish, { once: true });
    return { controller: childController, signal: childSignal };
  };
  const settle = async () => {
    clearTimeout(timer);
    timers.delete(timer);
    t.signal.removeEventListener("abort", onParentAbort);
    for (const entry of children) {
      entry.controller.abort(new Error("Phase budget retired"));
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
        timers.delete(entry.timer);
      }
    }
    children.clear();
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
  };
  return { signal, child, settle, expired };
};

const isDidKey = (value) =>
  typeof value === "string" && value.startsWith("did:key:");

const requireObservedOperation = (response) => {
  if (!Array.isArray(response?.rotationKeys))
    throw new Error("Invalid PLC rotation keys");
  for (const key of response.rotationKeys)
    if (!isDidKey(key)) throw new Error("Invalid PLC rotation keys");
  const { verificationMethods } = response;
  if (
    typeof verificationMethods !== "object" ||
    verificationMethods === null ||
    Array.isArray(verificationMethods)
  )
    throw new Error("Invalid PLC verification methods");
  for (const key of Object.values(verificationMethods))
    if (!isDidKey(key)) throw new Error("Invalid PLC verification methods");
  if (!isDidKey(verificationMethods.atproto))
    throw new Error("Invalid PLC verification methods");
  return {
    rotationKeys: [...response.rotationKeys],
    verificationMethods: { ...verificationMethods },
  };
};

const createManagedObservation = ({ fetch, signal }) => {
  if (typeof fetch !== "function") throw new TypeError("Invalid fetch");
  if (!signal) throw new TypeError("A managed boundary requires a signal");
  const io = createIncomingPublicIo({ fetch, signal, timeoutMs: 5_000 });
  return {
    async readLastOperation(endpoint, did, childSignal) {
      const origin = new URL(endpoint);
      const response = await io.call(
        new URL(`/${encodeURIComponent(did)}/log/last`, origin).href,
        { verb: "GET", signal: childSignal },
      );
      return requireObservedOperation(response);
    },
    readJson: (url, childSignal) =>
      io.call(url, { verb: "GET", signal: childSignal }),
    async pollStockConfirmation(options, child, { intervalMs = 250 } = {}) {
      const endpoint = new URL("/api/v1/search", options.baseUrl);
      endpoint.searchParams.set("query", `to:${options.recipient}`);
      endpoint.searchParams.set("limit", "50");
      const excludeIds = new Set(options.excludeIds);
      const hasRecipient = (message) =>
        Array.isArray(message.To) &&
        message.To.some(
          (item) =>
            item.Address?.toLowerCase() === options.recipient.toLowerCase(),
        );
      for (;;) {
        if (child.signal.aborted) throw child.signal.reason;
        const result = await this.readJson(endpoint.href, child.signal);
        if (!Array.isArray(result.messages))
          throw new Error("Invalid Mailpit response");
        const candidates = result.messages.filter(
          (item) =>
            typeof item.ID === "string" &&
            !excludeIds.has(item.ID) &&
            hasRecipient(item) &&
            Date.parse(item.Created) >= options.since &&
            item.Subject === "PLC Update Operation Requested",
        );
        if (candidates.length > 1)
          throw new Error("Ambiguous stock PLC messages");
        if (candidates.length === 1) {
          const detail = await this.readJson(
            new URL(
              `/api/v1/message/${encodeURIComponent(candidates[0].ID)}`,
              options.baseUrl,
            ).href,
            child.signal,
          );
          if (!hasRecipient(detail) || detail.ID !== candidates[0].ID)
            throw new Error("Invalid Mailpit message boundary");
          return { token: parseStockPlcMessage(detail), messageId: detail.ID };
        }
        await abortableDelay(intervalMs, child.signal);
      }
    },
    close: (options) => io.close(options),
  };
};

const abortableDelay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

test(
  "managed boundary cancellation reaches the injected transport",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const budget = createPhaseBudget(t, { deadlineMs: 5_000 });
    const seen = [];
    const observation = createManagedObservation({
      signal: budget.signal,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          seen.push(init.signal);
          init.signal.addEventListener("abort", () =>
            reject(init.signal.reason),
          );
        }),
    });
    t.after(() => observation.close({ settleTimeoutMs }));
    const phase = budget.child();
    const pending = observation.readLastOperation(
      "https://plc.example",
      "did:plc:example",
      phase.signal,
    );
    const early = await Promise.race([
      pending.then(
        () => "settled",
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    assert.equal(early, "pending", "The request must still be in flight");
    phase.controller.abort(new Error("phase cancelled by test"));
    const outcome = await pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    assert.equal(outcome.error?.message, "phase cancelled by test");
    assert.equal(seen.length, 1, "The transport saw exactly one dispatch");
    assert.equal(
      seen[0].aborted,
      true,
      "Cancellation must reach the transport signal, not only the caller",
    );
  },
);

test(
  "managed boundary reports a PLC non-2xx as a typed status error",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const budget = createPhaseBudget(t, { deadlineMs: 5_000 });
    const observation = createManagedObservation({
      signal: budget.signal,
      fetch: async () =>
        new Response(new Uint8Array([1]), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    });
    t.after(() => observation.close({ settleTimeoutMs }));
    const outcome = await observation
      .readLastOperation("https://plc.example", "did:plc:example")
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    assert.ok(outcome.error instanceof ResponseStatusError);
    assert.equal(outcome.error.status, 404);
  },
);

test(
  "managed boundary propagates the phase deadline as its own failure",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const budget = createPhaseBudget(t, { deadlineMs: 25 });
    let aborted = false;
    const observation = createManagedObservation({
      signal: budget.signal,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal.reason);
          });
        }),
    });
    t.after(() => observation.close({ settleTimeoutMs }));
    const outcome = await observation
      .readLastOperation("https://plc.example", "did:plc:example")
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    assert.equal(outcome.error?.message, "Phase budget exhausted");
    assert.equal(aborted, true, "The deadline must reach the transport");
  },
);
test(
  "managed observation returns the observed PLC verification methods it validated",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const budget = createPhaseBudget(t, { deadlineMs: 5_000 });
    const rotationKeys = [
      "did:key:zQ3shP2mWsZYWK55LZTotwS4VBDQk7ztNzESpMDDfBQ8VVNsY",
    ];
    const verificationMethods = {
      atproto: "did:key:zQ3shP2mWsZYWK55LZTotwS4VBDQk7ztNzESpMDDfBQ8VVNsY",
    };
    const observation = createManagedObservation({
      signal: budget.signal,
      fetch: async () =>
        new Response(
          JSON.stringify({
            did: "did:plc:example",
            rotationKeys,
            verificationMethods,
            alsoKnownAs: [],
            services: {},
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    t.after(async () => {
      await observation.close({ settleTimeoutMs });
      await budget.settle();
    });
    const initial = await observation.readLastOperation(
      "https://plc.example",
      "did:plc:example",
      budget.child().signal,
    );
    assert.deepEqual(
      initial.rotationKeys,
      rotationKeys,
      "The rotation keys the caller verifies against survive the boundary",
    );
    assert.equal(
      initial.verificationMethods?.atproto,
      verificationMethods.atproto,
      "The repository signature key used by the caller must survive the boundary, not be projected away",
    );
  },
);

test(
  "managed observation rejects a PLC response missing or malforming verification methods",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const budget = createPhaseBudget(t, { deadlineMs: 5_000 });
    const respondWith = (payload) =>
      createManagedObservation({
        signal: budget.signal,
        fetch: async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });
    t.after(() => budget.settle());
    const rotationKeys = ["did:key:zQ3shRotationKeyForTheBoundary"];
    const cases = [
      {
        name: "omitted verificationMethods",
        payload: { rotationKeys },
        message: "Invalid PLC verification methods",
      },
      {
        name: "null verificationMethods",
        payload: { rotationKeys, verificationMethods: null },
        message: "Invalid PLC verification methods",
      },
      {
        name: "non-string atproto method",
        payload: { rotationKeys, verificationMethods: { atproto: 42 } },
        message: "Invalid PLC verification methods",
      },
      {
        name: "empty atproto method",
        payload: { rotationKeys, verificationMethods: { atproto: "" } },
        message: "Invalid PLC verification methods",
      },
      {
        name: "omitted rotationKeys",
        payload: { verificationMethods: { atproto: "did:key:zQ3shAtproto" } },
        message: "Invalid PLC rotation keys",
      },
    ];
    for (const { name, payload, message } of cases) {
      const observation = respondWith(payload);
      try {
        const outcome = await observation
          .readLastOperation(
            "https://plc.example",
            "did:plc:example",
            budget.child().signal,
          )
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        assert.equal(
          outcome.error?.message,
          message,
          `${name}: a malformed PLC operation must be rejected at the boundary`,
        );
      } finally {
        await observation.close({ settleTimeoutMs });
      }
    }
  },
);

const createPhasedClient = (t, { deadlineMs }) => {
  if (!t.signal) throw new TypeError("A node test signal is required");
  assertBudgetDeadline(deadlineMs);
  const budget = createPhaseBudget(t, { deadlineMs });
  const clients = new Set();
  let phaseCount = 0;
  const startPhase = (options = {}) => {
    const phase = budget.child();
    const client = createIncomingPublicIo({ ...options, signal: phase.signal });
    clients.add(client);
    phaseCount += 1;
    return { client, signal: phase.signal, controller: phase.controller };
  };
  const endPhase = async ({ client }) => {
    await client.close({ settleTimeoutMs });
    clients.delete(client);
  };
  return {
    budget,
    startPhase,
    endPhase,
    phaseCount: () => phaseCount,
    clientCount: () => clients.size,
    async retire({ settleTimeoutMs: settleMs = settleTimeoutMs } = {}) {
      for (const client of clients)
        await client.close({ settleTimeoutMs: settleMs });
      clients.clear();
      await budget.settle();
    },
  };
};

test(
  "each source phase gets a fresh budget after the preflight retires",
  { timeout: preflightBudgetMs * 3 + settleTimeoutMs },
  async (t) => {
    const dispatch = [];
    const transport = (_url, init) =>
      new Promise((_resolve, reject) => {
        dispatch.push(init.signal);
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    const settled = (promise) =>
      Promise.race([
        promise.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
      ]);

    const preflight = createPhasedClient(t, { deadlineMs: 40 });
    const prerequisite = preflight.startPhase({ fetch: transport });
    const prerequisites = prerequisite.client
      .call("https://source.example/xrpc/prerequisite", { verb: "GET" })
      .catch((error) => error);
    assert.equal(
      (await prerequisites)?.message,
      "Phase budget exhausted",
      "The preflight budget expires on its own",
    );
    await preflight.endPhase(prerequisite);
    await preflight.retire();

    const firstPhase = createPhasedClient(t, { deadlineMs: exportBudgetMs });
    const first = firstPhase.startPhase({ fetch: transport });
    const firstOutcome = first.client
      .call("https://source.example/xrpc/getRepo", { verb: "GET" })
      .catch((error) => error);
    assert.equal(
      await settled(firstOutcome),
      "pending",
      "An expired preflight must not abort a later phase's fresh budget",
    );
    first.controller.abort(new Error("first phase cancelled by test"));
    assert.equal(
      (await firstOutcome)?.message,
      "first phase cancelled by test",
      "The phase's own cancellation reason reaches the actual transport",
    );
    assert.equal(
      dispatch.at(-1).aborted,
      true,
      "Cancellation reaches the transport signal of that phase's own client",
    );
    await firstPhase.endPhase(first);
    await firstPhase.retire();

    const secondPhase = createPhasedClient(t, { deadlineMs: exportBudgetMs });
    const second = secondPhase.startPhase({ fetch: transport });
    const secondOutcome = second.client
      .call("https://source.example/xrpc/getRepo", { verb: "GET" })
      .catch((error) => error);
    assert.equal(
      await settled(secondOutcome),
      "pending",
      "The next phase starts with a fresh budget, not the retired one",
    );
    second.controller.abort(new Error("second phase cancelled by test"));
    assert.equal(
      (await secondOutcome)?.message,
      "second phase cancelled by test",
      "Each new export gets its own fresh budget",
    );
    await secondPhase.endPhase(second);
    await secondPhase.retire();

    assert.equal(
      dispatch.length,
      3,
      "Each phase dispatched exactly once through its own client",
    );
    assert.equal(firstPhase.phaseCount(), 1);
    assert.equal(secondPhase.phaseCount(), 1);
  },
);

test(
  "a cancelled parent phase reaches the request through its own client",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    let transportSignal;
    const phase = createPhasedClient(t, { deadlineMs: exportBudgetMs });
    const bound = phase.startPhase({
      fetch: (_url, init) => {
        transportSignal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(init.signal.reason),
          );
        });
      },
    });
    const outcome = bound.client
      .call("https://source.example/xrpc/getRepo", { verb: "GET" })
      .catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    bound.controller.abort(new Error("phase cancelled by test"));
    assert.equal(
      (await outcome)?.message,
      "phase cancelled by test",
      "The cancellation reaches the request through that client",
    );
    assert.equal(transportSignal.aborted, true);
    await phase.endPhase(bound);
    await phase.retire();
    assert.equal(phase.clientCount(), 0, "No client remains tracked");
  },
);

const readProjection = async () => {
  if (!process.env.INCOMING_ACCESS_PATH || !process.env.INCOMING_PROJECT)
    throw new Error("Missing managed projection or project");
  const access = JSON.parse(
    await readFile(process.env.INCOMING_ACCESS_PATH, "utf8"),
  );
  if (
    access.schemaVersion !== 1 ||
    access.project !== process.env.INCOMING_PROJECT
  )
    throw new Error("Projection project mismatch");
  for (const value of [
    access.sourceUrl,
    access.entrywayUrl,
    access.plcUrl,
    access.mailpitUrl,
    ...(access.destinationUrls ?? []),
  ]) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin !== value
    )
      throw new Error("Invalid projection origin");
  }
  if (
    !Array.isArray(access.destinationUrls) ||
    access.destinationUrls.length !== 2
  )
    throw new Error("Missing destination projection");
  return access;
};

test(
  "phase budget composes an independent deadline with the node test signal",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const budget = createPhaseBudget(t, { deadlineMs: 5_000 });
    const signals = budget.signal;
    assert.ok(signals, "A composed phase signal is required");
    assert.notEqual(
      signals,
      t.signal,
      "The phase deadline must not replace the node test signal",
    );
    assert.equal(t.signal.aborted, false);
    assert.equal(
      signals.aborted,
      false,
      "The composed phase signal is live while within budget",
    );
    const child = budget.child();
    assert.ok(child.signal instanceof AbortSignal);
    assert.notEqual(
      child.signal,
      signals,
      "Each call gets its own child signal",
    );
    assert.notEqual(
      budget.child().signal,
      child.signal,
      "Child signals are never shared between calls",
    );
    await budget.settle();
  },
);

test(
  "an exhausted phase budget aborts the parent and its live children",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const budget = createPhaseBudget(t, { deadlineMs: 25 });
    const first = budget.child();
    const second = budget.child();
    const exhausted = await within(budget.signal, 1_000);
    assert.ok(exhausted.error, "An exhausted budget must abort");
    assert.equal(exhausted.error.message, "Phase budget exhausted");
    assert.equal(
      first.signal.aborted,
      true,
      "Child cancellation follows the parent",
    );
    assert.equal(second.signal.aborted, true, "Every live child is cancelled");
    assert.equal(t.signal.aborted, false, "The test signal is left untouched");
    await budget.settle();
  },
);

test(
  "an aggregate parent ceiling outlives its child phases",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const aggregate = createPhaseBudget(t, { deadlineMs: 2_000 });
    const phase = aggregate.child({ deadlineMs: 25 });
    assert.equal(phase.signal.aborted, false);
    await within(phase.signal, 25).then(({ error }) => {
      assert.equal(error?.message, "Phase budget exhausted");
    });
    assert.equal(
      phase.signal.aborted,
      true,
      "The child phase expires on its own",
    );
    assert.equal(
      aggregate.signal.aborted,
      false,
      "A child expiry must not exhaust the aggregate ceiling",
    );
    await aggregate.settle();
  },
);

test(
  "cancelling one phase leaves the aggregate and other phases usable",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const aggregate = createPhaseBudget(t, { deadlineMs: 2_000 });
    const cancelled = aggregate.child({ deadlineMs: 2_000 });
    const survivor = aggregate.child({ deadlineMs: 2_000 });
    cancelled.controller.abort(new Error("phase cancelled by test"));
    assert.equal(cancelled.signal.aborted, true);
    assert.equal(cancelled.signal.reason.message, "phase cancelled by test");
    assert.equal(
      aggregate.signal.aborted,
      false,
      "Independent phases are not cancelled with their sibling",
    );
    assert.equal(survivor.signal.aborted, false);
    await survivor.controller.abort(new Error("retired by test"));
    await aggregate.settle();
  },
);

test(
  "a parent ceiling expiry reaches composed children without touching the test signal",
  { timeout: preflightBudgetMs + settleTimeoutMs },
  async (t) => {
    const ceiling = createPhaseBudget(t, { deadlineMs: 25 });
    const child = ceiling.child();
    assert.equal(child.signal.aborted, false);
    const exhausted = await within(ceiling.signal, 1_000);
    assert.equal(exhausted.error?.message, "Phase budget exhausted");
    assert.equal(
      child.signal.aborted,
      true,
      "The ceiling must reach the composed child signal",
    );
    assert.equal(
      child.signal.reason?.message,
      "Phase budget exhausted",
      "The child keeps the ceiling reason, not a rewritten one",
    );
    assert.equal(t.signal.aborted, false, "The node signal is never assigned");
    await ceiling.settle();
  },
);

test(
  "standalone public signup and PLC confirmation preflight",
  { skip: !process.env.INCOMING_PUBLIC_MECHANISMS },
  async (t) => {
    const access = await readProjection();
    const preflight = createPhasedClient(t, { deadlineMs: preflightBudgetMs });
    t.after(() => preflight.retire());
    const xrpc = (method) => `${access.sourceUrl}/xrpc/${method}`;

    const prerequisite = preflight.startPhase({
      timeoutMs: requestTimeoutMs,
    });
    const source = prerequisite.client;
    const prereqSignal = prerequisite.signal;
    const description = await source.call(
      xrpc("com.atproto.server.describeServer"),
      { verb: "GET" },
    );
    if (
      description.inviteCodeRequired ||
      !Array.isArray(description.availableUserDomains) ||
      !description.availableUserDomains[0]
    )
      throw new Error("Standalone signup unavailable");
    const unique = randomUUID().replaceAll("-", "");
    const email = `public-${unique}@example.com`;
    const password = `Public-${randomUUID()}!`;
    const handle = `u${unique.slice(0, 16)}${description.availableUserDomains[0]}`;
    const account = await source.call(
      xrpc("com.atproto.server.createAccount"),
      {
        json: { email, password, handle },
      },
    );
    if (typeof account.did !== "string") throw new Error("Signup omitted DID");
    const session = await source.call(
      xrpc("com.atproto.server.createSession"),
      {
        json: { identifier: account.did, password },
      },
    );
    if (session.did !== account.did || typeof session.accessJwt !== "string")
      throw new Error("Session did not match account");

    const observation = createManagedObservation({
      signal: prereqSignal,
      fetch: (url, init) => globalThis.fetch(url, init),
    });
    t.after(() => observation.close({ settleTimeoutMs }));
    const search = new URL("/api/v1/search", access.mailpitUrl);
    search.searchParams.set("query", `to:${email}`);
    search.searchParams.set("limit", "50");
    const prior = await observation.readJson(search.href, prereqSignal);
    if (!Array.isArray(prior.messages))
      throw new Error("Invalid Mailpit search");
    const since = Date.now();
    const excludeIds = prior.messages.map((item) => item.ID);
    await source.call(
      xrpc("com.atproto.identity.requestPlcOperationSignature"),
      {
        token: session.accessJwt,
        signal: prereqSignal,
      },
    );
    const confirmation = await observation.pollStockConfirmation(
      { recipient: email, since, excludeIds, baseUrl: access.mailpitUrl },
      prerequisite,
    );
    const initial = await observation.readLastOperation(
      access.plcUrl,
      account.did,
      prereqSignal,
    );
    const signed = await source.call(
      xrpc("com.atproto.identity.signPlcOperation"),
      { token: session.accessJwt, json: { token: confirmation.token } },
    );
    if (!signed.operation) throw new Error("PLC signing omitted operation");
    await plc.assureValidSig(initial.rotationKeys, signed.operation);
    assert.ok(true, "Public signing verified");

    const exportUrl = new URL(
      "/xrpc/com.atproto.sync.getRepo",
      access.sourceUrl,
    );
    exportUrl.searchParams.set("did", account.did);
    await preflight.endPhase(prerequisite);
    await preflight.retire();

    const phaseFor = (bound) => {
      const exportRepo = () =>
        bound.client.call(exportUrl.href, {
          token: session.accessJwt,
          verb: "GET",
          expect: "car",
        });
      const write = (writes) =>
        bound.client.call(xrpc("com.atproto.repo.applyWrites"), {
          token: session.accessJwt,
          json: { repo: account.did, writes },
          expect: "status",
        });
      return { ...bound, exportRepo, write };
    };
    const collection = "app.bsky.feed.post";
    const record = (text) => ({
      $type: collection,
      text,
      createdAt: "2026-10-06T00:00:00.000Z",
    });
    const action = (kind, rkey, text) => ({
      $type: `com.atproto.repo.applyWrites#${kind}`,
      collection,
      rkey,
      ...(text === undefined ? {} : { value: record(text) }),
    });
    const [one, two, three] = [
      "3mznesxxhic2e",
      "3mznesxxhid2e",
      "3mznesxxhie2e",
    ];

    await t.test(
      "full source CAR verifies against the observed PLC key",
      { timeout: exportBudgetMs + settleTimeoutMs },
      async (child) => {
        const owner = createPhasedClient(child, { deadlineMs: exportBudgetMs });
        child.after(() => owner.retire());
        const phase = phaseFor(
          owner.startPhase({ timeoutMs: requestTimeoutMs }),
        );
        try {
          const bytes = await phase.exportRepo();
          assert.ok(bytes.byteLength <= carLimitBytes);
          const verified = await verifyRepoCar(bytes, account.did);
          const car = await readCarWithRoot(bytes);
          const commit = ensureV3Commit(
            await new MemoryBlockstore(car.blocks).readObj(
              car.root,
              def.versionedCommit,
            ),
          );
          assert.equal(verified.commit.cid.toString(), car.root.toString());
          assert.equal(commit.did, account.did);
          assert.equal(verified.creates.length, 0);
          assert.equal(
            await verifyCommitSig(commit, initial.verificationMethods.atproto),
            true,
          );
        } finally {
          await owner.retire();
        }
      },
    );

    await t.test(
      "nonempty source snapshots and bounded export-write overlap",
      { timeout: exportBudgetMs + settleTimeoutMs },
      async (child) => {
        const owner = createPhasedClient(child, { deadlineMs: exportBudgetMs });
        child.after(() => owner.retire());
        const phase = phaseFor(
          owner.startPhase({ timeoutMs: requestTimeoutMs }),
        );
        const { exportRepo, write } = phase;
        try {
          const verifyExport = async (bytes) => {
            const verified = await verifyRepoCar(
              bytes,
              account.did,
              initial.verificationMethods.atproto,
            );
            const car = await readCarWithRoot(bytes);
            assert.equal(verified.commit.cid.toString(), car.root.toString());
            return {
              root: car.root.toString(),
              inventory: verified.creates
                .map(
                  ({ collection: name, rkey, cid }) => `${name}/${rkey}/${cid}`,
                )
                .sort(),
            };
          };
          assert.equal(
            await write([
              action("create", one, "original"),
              action("create", two, "removed"),
            ]),
            200,
          );
          const before = await verifyExport(await exportRepo());
          assert.equal(before.inventory.length, 2);
          assert.equal(
            await write([
              action("update", one, "updated"),
              action("delete", two),
              action("create", three, "added"),
            ]),
            200,
          );
          const after = await verifyExport(await exportRepo());
          assert.equal(after.inventory.length, before.inventory.length);
          assert.notDeepEqual(after.inventory, before.inventory);
          assert.notEqual(after.root, before.root);
          assert.deepEqual(
            after.inventory.map((entry) => entry.split("/")[1]),
            [one, three],
          );
          const pendingExports = [exportRepo(), exportRepo()];
          const overlapWrite = write([action("update", one, "overlap")]);
          const captures = await Promise.all(
            (await Promise.all(pendingExports)).map(verifyExport),
          );
          assert.equal(await overlapWrite, 200);
          const final = await verifyExport(await exportRepo());
          assert.equal(final.inventory.length, 2);
          assert.notDeepEqual(final.inventory, after.inventory);
          for (const capture of captures) {
            const matching = [after, final].find(
              (snapshot) => snapshot.root === capture.root,
            );
            assert.ok(
              matching,
              "Captured root must be a known complete state; the export was in flight when the write was dispatched and the server may already have buffered its response, so overlap is not a finality proof",
            );
            assert.deepEqual(capture.inventory, matching.inventory);
          }
        } finally {
          await owner.retire();
        }
      },
    );
  },
);

test(
  "Entryway-hosted inactive destination and streamed import",
  {
    skip: !process.env.INCOMING_PUBLIC_MECHANISMS,
    timeout: destinationBudgetMs + settleTimeoutMs,
  },
  async (t) => {
    const access = await readProjection();
    const { chromium } = await import("playwright");
    const { createAccount, config } =
      await import("../support/helpers/browser-oauth.mjs");
    const phaseBudget = createPhaseBudget(t, {
      deadlineMs: destinationBudgetMs,
    });
    const browser = await chromium.launch({ headless: true });
    let destination;
    t.after(async () => {
      await destination?.close({ settleTimeoutMs });
      await browser.close();
      await phaseBudget.settle();
    });
    const page = await browser.newPage();
    const identity = await createAccount(page, "destination-probe");
    const password = `Public qualification ${randomUUID()}!`;
    const form = page.locator('form[action="/account/password-set"]');
    await form.getByLabel("New account password").fill(password);
    await form.getByRole("button").click();
    const origin = config.pds[0].url;
    assert.ok(
      access.destinationUrls.includes(origin),
      "Hosted PDS must be projected destination",
    );
    destination = createIncomingPublicIo({
      timeoutMs: requestTimeoutMs,
      carLimitBytes,
      signal: phaseBudget.signal,
    });
    const xrpc = (method) => `${origin}/xrpc/${method}`;
    const attempt = async (method, options = {}) => {
      try {
        return {
          status: 200,
          body: await destination.call(xrpc(method), options),
        };
      } catch (error) {
        if (!(error instanceof ResponseStatusError)) throw error;
        return { status: error.status, body: error.body };
      }
    };
    const login = await attempt("com.atproto.server.createSession", {
      json: { identifier: identity.did, password },
    });
    assert.equal(login.status, 200);
    const session = login.body;
    assert.equal(session.did, identity.did);
    assert.equal(typeof session.accessJwt, "string");
    assert.equal(typeof session.refreshJwt, "string");
    const token = session.accessJwt;
    const query = `?did=${encodeURIComponent(identity.did)}`;
    const exportRepo = () =>
      destination.call(`${xrpc("com.atproto.sync.getRepo")}${query}`, {
        token,
        verb: "GET",
        expect: "car",
      });
    const write = (writes) =>
      attempt("com.atproto.repo.applyWrites", {
        token,
        json: { repo: identity.did, writes },
      });
    const inventoryOf = (bytes) =>
      verifyRepoCar(bytes, identity.did).then(({ creates }) =>
        creates
          .map(({ collection: name, rkey, cid }) => `${name}/${rkey}/${cid}`)
          .sort(),
      );
    const collection = "app.bsky.feed.post";
    const rkey = "3mznesxxhic2e";
    const createAction = {
      $type: "com.atproto.repo.applyWrites#create",
      collection,
      rkey,
      value: {
        $type: collection,
        text: "destination snapshot",
        createdAt: "2026-10-06T00:00:00.000Z",
      },
    };
    const deleteAction = {
      $type: "com.atproto.repo.applyWrites#delete",
      collection,
      rkey,
    };
    assert.equal((await write([createAction])).status, 200);
    const originalCar = await exportRepo();
    const originalInventory = await inventoryOf(originalCar);
    assert.deepEqual(
      originalInventory.map((entry) => entry.split("/")[1]),
      [rkey],
      "Destination observation compares a full sorted inventory, never a count or presence claim",
    );
    assert.equal((await write([deleteAction])).status, 200);
    assert.deepEqual(await inventoryOf(await exportRepo()), []);

    const deactivated = await attempt("com.atproto.server.deactivateAccount", {
      token,
      json: {},
    });
    t.diagnostic(`deactivate backend HTTP ${deactivated.status}`);
    assert.equal(deactivated.status, 200, "public deactivation prerequisite");

    const status = async () => {
      const result = await attempt("com.atproto.server.checkAccountStatus", {
        token,
        verb: "GET",
      });
      assert.equal(result.status, 200);
      return result.body;
    };
    assert.equal((await status()).activated, false);
    assert.deepEqual(await inventoryOf(await exportRepo()), []);

    const missing = await attempt("com.atproto.repo.listMissingBlobs", {
      token,
      verb: "GET",
    });
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body.blobs, []);
    assert.equal(
      missing.body.cursor,
      undefined,
      "A blob-free repository reports no cursor; this is not pagination",
    );

    const inactiveWrite = await write([createAction]);
    assert.equal(inactiveWrite.status, 401);
    assert.equal(inactiveWrite.body?.error, "AccountDeactivated");
    assert.deepEqual(await inventoryOf(await exportRepo()), []);

    assert.equal(
      (
        await attempt("com.atproto.server.refreshSession", {
          token: session.refreshJwt,
        })
      ).status,
      400,
      "Deactivation also refuses the local refresh family",
    );

    const firstImport = await attempt("com.atproto.repo.importRepo", {
      token,
      bytes: originalCar,
      expect: "text",
    });
    assert.equal(firstImport.status, 200);
    assert.equal(
      firstImport.body.length,
      0,
      "A successful import returns an empty body; it is not data",
    );
    const importedInventory = await inventoryOf(await exportRepo());
    assert.deepEqual(importedInventory, originalInventory);

    const repeatedImport = await attempt("com.atproto.repo.importRepo", {
      token,
      bytes: originalCar,
      expect: "text",
    });
    assert.equal(repeatedImport.status, 200);
    assert.equal(repeatedImport.body.length, 0);
    assert.deepEqual(
      await inventoryOf(await exportRepo()),
      importedInventory,
      "A repeated same-DID import is idempotent",
    );

    const upload = await attempt("com.atproto.repo.uploadBlob", {
      token,
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      headers: { "content-type": "image/png" },
    });
    assert.equal(upload.status, 200);
    assert.equal(typeof upload.body.blob?.ref?.$link, "string");
    assert.equal(upload.body.blob.size, 8);
    assert.equal(upload.body.blob.mimeType, "image/png");

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const sent = new Promise((resolve) => {
      started = resolve;
    });
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(originalCar.subarray(0, originalCar.length - 1));
        started();
        await gate;
        try {
          controller.enqueue(originalCar.subarray(originalCar.length - 1));
          controller.close();
        } catch {
          release();
        }
      },
      cancel() {
        release();
      },
    });
    const held = runHeldStreamedCall(
      destination,
      xrpc("com.atproto.repo.importRepo"),
      { token, bytes: stream, expect: "text", deadlineMs: requestTimeoutMs },
    );
    t.after(() => held.retireNow({ settleTimeoutMs }));
    try {
      await sent;
      const held = await status();
      assert.equal(held.activated, false);
      assert.equal(typeof held.repoCommit, "string");
      assert.equal(typeof held.repoRev, "string");
      assert.equal(typeof held.indexedRecords, "number");
      assert.equal(typeof held.repoBlocks, "number");
      assert.equal(
        (
          await attempt("com.atproto.server.activateAccount", {
            token,
          })
        ).status,
        401,
        "Delegated activation is refused and the account stays inactive: deactivation revoked the local session family, the Entryway hop passes the backend's stable refusal through, and this is not evidence of a pending-arrival guard",
      );
    } finally {
      release();
    }
    await held.consume({ expect: "text" });

    const finalStatus = await status();
    assert.equal(finalStatus.activated, false);
    assert.deepEqual(
      await inventoryOf(await exportRepo()),
      importedInventory,
      "The released import preserves the exact completed inventory; this equality is a separate observation and does not by itself prove the held stream succeeded",
    );
    t.diagnostic(
      "Withholding the final client byte does not prove the server received the prefix or establish universal finality; blob retention and pagination remain unqualified.",
    );
  },
);

test(
  "public reservation sequential retry and placement isolation",
  {
    skip: !process.env.INCOMING_PUBLIC_MECHANISMS,
    timeout: reservationBudgetMs + settleTimeoutMs,
  },
  async (t) => {
    const access = await readProjection();
    const phaseBudget = createPhaseBudget(t, {
      deadlineMs: reservationBudgetMs,
    });
    const reservation = createIncomingPublicIo({
      timeoutMs: requestTimeoutMs,
      signal: phaseBudget.signal,
    });
    t.after(async () => {
      await reservation.close({ settleTimeoutMs });
      await phaseBudget.settle();
    });
    const reserve = async (baseUrl, did) => {
      const result = await reservation.call(
        `${baseUrl}/xrpc/com.atproto.server.reserveSigningKey`,
        { json: { did }, signal: phaseBudget.child().signal },
      );
      assert.match(result.signingKey, /^did:key:/);
      return result.signingKey;
    };
    const did = `did:plc:${"a".repeat(24)}`;
    const first = await reserve(access.destinationUrls[0], did);
    assert.equal(await reserve(access.destinationUrls[0], did), first);
    assert.notEqual(await reserve(access.destinationUrls[1], did), first);
    assert.notEqual(
      await reserve(access.destinationUrls[0], `did:plc:${"b".repeat(24)}`),
      first,
    );
  },
);
