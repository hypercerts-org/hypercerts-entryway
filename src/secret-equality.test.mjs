import assert from "node:assert/strict";
import { test } from "node:test";
import { equalSecret } from "../dist/src/secret-equality.js";
import { canonicalBasic } from "../dist/src/http/authorization-scheme.js";

test("secret equality compares UTF-8 bytes and rejects different values and lengths", () => {
  assert.equal(equalSecret("fixture-κλειδί-🔐", "fixture-κλειδί-🔐"), true);
  assert.equal(equalSecret("fixture-a", "fixture-b"), false);
  assert.equal(equalSecret("fixture", "fixture-extra"), false);
  assert.equal(equalSecret("é", "e\u0301"), false);
});

test("canonical Basic comparison accepts scheme case only, not credential changes", () => {
  const expected = `Basic ${Buffer.from("admin:fixture").toString("base64")}`;
  assert.equal(
    equalSecret(canonicalBasic(`basic ${expected.slice(6)}`), expected),
    true,
  );
  assert.equal(equalSecret(canonicalBasic("Bearer fixture"), expected), false);
  assert.equal(equalSecret(canonicalBasic(undefined), expected), false);
  assert.equal(
    equalSecret(
      canonicalBasic(`Basic ${Buffer.from("admin:wrong").toString("base64")}`),
      expected,
    ),
    false,
  );
});
