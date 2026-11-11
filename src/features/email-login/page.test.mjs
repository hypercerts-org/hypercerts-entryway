import assert from "node:assert/strict";
import test from "node:test";
import {
  createLoginForms,
  maskEmail,
} from "../../../dist/src/features/email-login/page.mjs";

const { otpForm } = createLoginForms({
  fields: (flow) => `<input type="hidden" name="flow" value="${flow.id}">`,
});

test("a masked code page never contains the address or its local part", () => {
  const flow = { id: "flow", email: "karma.secret@zoepa.com", maskEmail: true };

  for (const html of [
    otpForm(flow, {}),
    otpForm(flow, {}, "Wait five seconds.", flow.email),
  ]) {
    assert.ok(html.includes("k••••@zoepa.com"));
    assert.ok(!html.includes("karma.secret"));
    assert.match(html, /id="change-email"[^>]*value=""/);
  }
});

test("a typed address is shown in full and prefilled for changes", () => {
  const html = otpForm({ id: "flow", email: "karma@zoepa.com" }, {});

  assert.ok(html.includes("<strong>karma@zoepa.com</strong>"));
  assert.match(html, /id="change-email"[^>]*value="karma@zoepa.com"/);
});

test("an address without a usable local part is not partially echoed", () => {
  assert.equal(maskEmail("@zoepa.com"), "your account email");
  assert.equal(maskEmail(undefined), "your account email");
});
