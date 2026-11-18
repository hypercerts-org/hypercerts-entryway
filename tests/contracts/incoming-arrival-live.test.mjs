import assert from "node:assert/strict";
import test from "node:test";
import {
  qualifyIncomingArrival,
  discardAppliedArrivalResponse,
} from "../support/helpers/incoming-arrival-live.mjs";

test("arrival response discard drains only the first successful matching fault response", async () => {
  for (const [fault, method] of [
    ["creation-lost", "com.atproto.server.createAccount"],
    ["pause-lost", "com.atproto.admin.updateSubjectStatus"],
  ]) {
    const applied = new Response("applied");
    assert.equal(
      await discardAppliedArrivalResponse({
        fault,
        method,
        response: applied,
        discarded: false,
      }),
      true,
    );
    assert.equal(applied.bodyUsed, true);
    for (const overrides of [
      { fault: "normal" },
      { method: "com.atproto.server.reserveSigningKey" },
      {
        method:
          fault === "creation-lost"
            ? "com.atproto.admin.updateSubjectStatus"
            : "com.atproto.server.createAccount",
      },
      { discarded: true },
      { status: 503 },
    ]) {
      const response = new Response("untouched", {
        status: overrides.status ?? 200,
      });
      assert.equal(
        await discardAppliedArrivalResponse({
          fault,
          method,
          discarded: false,
          ...overrides,
          response,
        }),
        false,
      );
      assert.equal(response.bodyUsed, false);
    }
  }
});

test(
  "stock source reaches composed inactive pending arrival without fixture authority",
  {
    skip: !process.env.INCOMING_PUBLIC_MECHANISMS,
    timeout: 120_000,
  },
  (t) => qualifyIncomingArrival(t),
);

for (const fault of ["creation-lost", "pause-lost"]) {
  test(
    `stock applied ${fault} remains unbound and rejects unsafe retry`,
    {
      skip: !process.env.INCOMING_PUBLIC_MECHANISMS,
      timeout: 120_000,
    },
    (t) => qualifyIncomingArrival(t, fault),
  );
}
