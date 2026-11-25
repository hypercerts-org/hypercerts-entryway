/** A sandbox observation never authenticates code or configuration read at launch. */
export function stagedObservation(before, after, cases) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error("Qualification destination changed during test");
  const expected = [
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
  const key = (entry) =>
    `${entry.project}:${entry.name}:${entry.status}:${entry.retry}`;
  if (
    !Array.isArray(cases) ||
    cases.map(key).sort().join("\n") !== expected.map(key).sort().join("\n")
  )
    throw Error(
      "Qualification did not execute the required cases successfully",
    );
  return {
    version: 1,
    kind: "isolated-sandbox-observation",
    registryImportable: false,
    launchContent: "unverified",
    credentialVersionReferences: null,
    registryRevision: null,
    expectedUpstreamRevision: "9c31da3d73bbc35ca1b1e32d1fd488acfd754c61",
    ...before,
    cases: expected,
  };
}
