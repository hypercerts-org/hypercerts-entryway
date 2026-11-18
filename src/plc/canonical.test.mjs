import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../../dist/src/plc/canonical.js";

test("canonical JSON sorts keys at every depth and keeps array order", () => {
  assert.equal(
    canonicalJson({ b: [2, { d: null, c: "x" }], a: true }),
    '{"a":true,"b":[2,{"c":"x","d":null}]}',
  );
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("canonical JSON output parses back to the same value", () => {
  const value = { z: [], a: { y: "é", x: 0 }, m: [null, false, "s"] };
  assert.deepEqual(JSON.parse(canonicalJson(value)), value);
});

test("canonical JSON refuses values that are not JSON", () => {
  for (const value of [
    undefined,
    { optional: undefined },
    [undefined],
    new Array(1),
    [1, , 3], // eslint-disable-line no-sparse-arrays
    () => {},
    Symbol("s"),
    1n,
    { nested: [{ deep: undefined }] },
  ])
    assert.throws(() => canonicalJson(value), TypeError);
});
