import assert from "node:assert/strict";
import test from "node:test";
import { stagedObservation } from "./staged-qualification-policy.mjs";

const cases = [
  {
    project: "cutover-at-entryway",
    name: "migration",
    status: "passed",
    retry: 0,
  },
  {
    project: "cutover-at-entryway",
    name: "signup",
    status: "passed",
    retry: 0,
  },
  {
    project: "cutover-at-destination",
    name: "migration",
    status: "passed",
    retry: 0,
  },
  {
    project: "cutover-at-destination",
    name: "signup",
    status: "skipped",
    retry: 0,
  },
];

test("unchanged mounted bytes do not prove what a running process loaded", () => {
  const observed = {
    containerId: "running",
    mountedLauncherSha256: "new",
    mountedConfigProjectionSha256: "new",
  };
  const receipt = stagedObservation(observed, observed, cases);
  assert.equal(receipt.launchContent, "unverified");
  assert.equal(receipt.registryImportable, false);
  assert.equal(receipt.credentialVersionReferences, null);
  const extra = cases.map((entry) => ({
    ...entry,
    unwanted: "must-not-escape",
  }));
  assert.equal(
    JSON.stringify(stagedObservation(observed, observed, extra)).includes(
      "must-not-escape",
    ),
    false,
  );
});

test("changed mounts or incomplete cases cannot create an observation", () => {
  assert.throws(
    () =>
      stagedObservation(
        { mountedLauncherSha256: "old" },
        { mountedLauncherSha256: "new" },
        cases,
      ),
    /changed/,
  );
  assert.throws(
    () => stagedObservation({}, {}, cases.slice(1)),
    /required cases/,
  );
  assert.throws(
    () =>
      stagedObservation(
        {},
        {},
        cases.map((entry) => ({ ...entry, retry: 1 })),
      ),
    /required cases/,
  );
});
