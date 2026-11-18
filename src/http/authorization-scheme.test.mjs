import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalBasic,
  schemeCredential,
} from "../../dist/src/http/authorization-scheme.js";

test("an authorization scheme is matched without regard to case", () => {
  for (const header of ["Bearer abc", "bearer abc", "BEARER abc"])
    assert.equal(schemeCredential(header, "Bearer"), "abc");
  for (const header of ["DPoP abc", "dpop abc", "DPOP abc"])
    assert.equal(schemeCredential(header, "DPoP"), "abc");
});

test("another scheme, a bare scheme and a non-string header give no credential", () => {
  assert.equal(schemeCredential("DPoP abc", "Bearer"), undefined);
  assert.equal(schemeCredential("Bearerabc", "Bearer"), undefined);
  assert.equal(schemeCredential("Bearer", "Bearer"), undefined);
  assert.equal(schemeCredential(undefined, "Bearer"), undefined);
  assert.equal(schemeCredential(["Bearer abc"], "Bearer"), undefined);
});

test("the credential is returned unchanged for the caller to validate", () => {
  assert.equal(schemeCredential("bearer a b", "Bearer"), "a b");
  assert.equal(schemeCredential("Bearer ", "Bearer"), "");
});

test("a Basic header is canonicalized by scheme only", () => {
  for (const header of ["Basic YWRtaW46UGFzcw==", "basic YWRtaW46UGFzcw=="])
    assert.equal(canonicalBasic(header), "Basic YWRtaW46UGFzcw==");
  // The credential keeps its case and bytes.
  assert.notEqual(
    canonicalBasic("BASIC ywrtaw46ugfzcw=="),
    "Basic YWRtaW46UGFzcw==",
  );
  for (const header of [undefined, "", "Basic", "Bearer abc", ["Basic abc"]])
    assert.equal(canonicalBasic(header), "");
});
