import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";

const integration = process.env.SERVICE_CONFIG_PATH ? test : test.skip;
let config, db, main, identity, adminAccount;
const password = `spike-${randomBytes(20).toString("hex")}`;
const unique = randomBytes(6).toString("hex");
const mail = (email, namespace = "outbox") => {
  const row = db
    .prepare("SELECT value FROM key_value_state WHERE namespace=? AND key=?")
    .get(namespace, email);
  return row && JSON.parse(row.value);
};
const bearer = (session) => `Bearer ${session.accessJwt}`;
const admin = (pds) =>
  `Basic ${Buffer.from(`admin:${pds?.adminPassword ?? config.adminPassword}`).toString("base64")}`;
async function request(
  origin,
  path,
  {
    body,
    auth,
    status = 200,
    strictJson = false,
    method = body === undefined ? "GET" : "POST",
  } = {},
) {
  const r = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(auth ? { authorization: auth } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = strictJson
    ? JSON.parse(await r.text())
    : await r.json().catch(() => ({}));
  assert.equal(
    r.status,
    status,
    `${method} ${path}: ${data.error ?? ""} ${data.message ?? ""}`,
  );
  return data;
}
const noInput = new Set([
  "server.refreshSession",
  "server.deleteSession",
  "server.requestEmailConfirmation",
  "server.requestEmailUpdate",
  "server.requestAccountDelete",
  "server.activateAccount",
  "identity.requestPlcOperationSignature",
]);
const call = (name, body, auth, options = {}) =>
  request(options.origin ?? config.issuer, `/xrpc/com.atproto.${name}`, {
    body: noInput.has(name) ? undefined : body,
    auth,
    ...(noInput.has(name) ? { method: "POST" } : {}),
    ...options,
  });
async function signup(label, pdsId = "pds1", extra = {}) {
  const email = `api-${unique}-${label}@example.com`;
  const handle = `api-${unique}-${label}.entryway.atmosbox.test`;
  await request(config.issuer, "/signup/request-code", { body: { email } });
  const session = await call("server.createAccount", {
    email,
    handle,
    pdsId,
    password,
    verificationCode: mail(email).otp,
    ...extra,
  });
  return {
    ...session,
    email,
    handle,
    pds: config.pds.find((p) => p.id === pdsId),
  };
}
before(async () => {
  if (!process.env.SERVICE_CONFIG_PATH) return;
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"));
  db = new DatabaseSync("/entryway-data/account-authority.sqlite", {
    readOnly: true,
  });
  main = await signup("legacy");
  identity = await signup("identity");
  adminAccount = await signup("admin", "pds2");
});
after(() => db?.close());

integration(
  "invalid signup password is rejected before proof consumption or account provisioning",
  async () => {
    const email = `api-${unique}-password-policy@example.com`;
    const handle = `api-${unique}-password-policy.entryway.atmosbox.test`;
    await request(config.issuer, "/signup/request-code", { body: { email } });
    const verificationCode = mail(email).otp;
    const rejected = await call(
      "server.createAccount",
      { email, handle, verificationCode, password: "short" },
      undefined,
      { status: 400 },
    );
    assert.equal(rejected.error, "InvalidPassword");
    assert.equal(
      db.prepare("SELECT did FROM accounts WHERE email=?").get(email),
      undefined,
    );
    const accepted = await call("server.createAccount", {
      email,
      handle,
      verificationCode,
      password,
    });
    assert.ok(accepted.did.startsWith("did:plc:"));
  },
);

integration(
  "verified XRPC signup creates password credentials and legacy sessions on two stock PDSs",
  async () => {
    for (const a of [main, adminAccount]) {
      const session = await call(
        "server.createSession",
        { identifier: a.handle, password },
        undefined,
        { origin: a.pds.url },
      );
      assert.equal(session.did, a.did);
      assert.equal(session.emailConfirmed, true);
      const details = await call(
        "server.getSession",
        undefined,
        bearer(session),
        {
          origin: a.pds.url,
        },
      );
      assert.equal(details.did, a.did);
      const record = await call(
        "repo.createRecord",
        {
          repo: a.did,
          collection: "org.hypercerts.spike.note",
          validate: false,
          record: {
            $type: "org.hypercerts.spike.note",
            text: "Legacy credentials against stock PDS",
          },
        },
        bearer(session),
        { origin: a.pds.url },
      );
      assert.ok(record.uri.startsWith(`at://${a.did}/`));
      await call("server.getSession", undefined, bearer(session), {
        origin: config.pds.find((p) => p.id !== a.pds.id).url,
        status: 400,
      });
    }
  },
);
integration(
  "legacy refresh rotates through PDS and replay revokes its family; logout rejects refresh",
  async () => {
    const session = await call("server.createSession", {
      identifier: main.did,
      password,
    });
    const next = await call(
      "server.refreshSession",
      {},
      `Bearer ${session.refreshJwt}`,
      {
        origin: main.pds.url,
      },
    );
    assert.notEqual(next.refreshJwt, session.refreshJwt);
    await call("server.refreshSession", {}, `Bearer ${session.refreshJwt}`, {
      origin: main.pds.url,
      status: 400,
    });
    await call("server.refreshSession", {}, `Bearer ${next.refreshJwt}`, {
      status: 400,
    });
    const second = await call("server.createSession", {
      identifier: main.email,
      password,
    });
    await call("server.deleteSession", {}, `Bearer ${second.refreshJwt}`, {
      origin: main.pds.url,
    });
    await call("server.refreshSession", {}, `Bearer ${second.refreshJwt}`, {
      status: 400,
    });
  },
);
integration(
  "app-password lifecycle works through stock PDS and cannot escalate to account-password authority",
  async () => {
    const item = await call(
      "server.createAppPassword",
      { name: "phase2-bot", privileged: false },
      bearer(main),
      { origin: main.pds.url },
    );
    assert.match(item.password, /^[a-z]{4}(-[a-z]{4}){3}$/);
    const bot = await call(
      "server.createSession",
      { identifier: main.handle, password: item.password },
      undefined,
      { origin: main.pds.url },
    );
    const listed = await call(
      "server.listAppPasswords",
      undefined,
      bearer(bot),
      {
        origin: main.pds.url,
      },
    );
    assert.ok(
      listed.passwords.some((p) => p.name === item.name && !("password" in p)),
    );
    await call(
      "server.createAppPassword",
      { name: "escalation" },
      bearer(bot),
      {
        origin: main.pds.url,
        status: 400,
      },
    );
    await call(
      "server.createAppPassword",
      { name: "direct-escalation" },
      bearer(bot),
      {
        status: 403,
      },
    );
    await call("server.revokeAppPassword", { name: item.name }, bearer(main), {
      origin: main.pds.url,
    });
    await call("server.refreshSession", {}, `Bearer ${bot.refreshJwt}`, {
      status: 400,
    });
    await call(
      "server.createSession",
      { identifier: main.handle, password: item.password },
      undefined,
      { status: 401 },
    );
  },
);
integration(
  "email change verifies both addresses, preserves DID and invalidates prior credentials",
  async () => {
    const a = await signup("email");
    await call("server.requestEmailConfirmation", {}, bearer(a), {
      origin: a.pds.url,
    });
    await call(
      "server.confirmEmail",
      { email: a.email, token: mail(a.email).token },
      bearer(a),
      {
        origin: a.pds.url,
      },
    );
    await call(
      "server.confirmEmail",
      { email: a.email, token: mail(a.email).token },
      bearer(a),
      {
        status: 400,
      },
    );
    const pending = await call("server.requestEmailUpdate", {}, bearer(a), {
      origin: a.pds.url,
    });
    assert.equal(pending.tokenRequired, true);
    const nextEmail = `api-${unique}-changed@example.com`;
    await call(
      "server.updateEmail",
      { email: nextEmail, token: mail(a.email).token },
      bearer(a),
      {
        origin: a.pds.url,
      },
    );
    const before = await call("server.getSession", undefined, bearer(a), {
      origin: a.pds.url,
    });
    assert.equal(before.email, a.email);
    await call(
      "server.confirmEmail",
      { email: nextEmail, token: mail(nextEmail).token },
      bearer(a),
      { origin: a.pds.url },
    );
    await call("server.refreshSession", {}, `Bearer ${a.refreshJwt}`, {
      status: 400,
    });
    const fresh = await call("server.createSession", {
      identifier: nextEmail,
      password,
    });
    assert.equal(fresh.did, a.did);
    assert.equal(fresh.email, nextEmail);
    assert.equal(fresh.emailConfirmed, true);
  },
);
integration(
  "password reset is purpose-bound, single use and revokes old sessions",
  async () => {
    const a = await signup("reset");
    await call("server.requestPasswordReset", { email: a.email }, undefined, {
      origin: a.pds.url,
    });
    const token = mail(a.email).token;
    await call(
      "server.deleteAccount",
      { did: a.did, password, token },
      undefined,
      { status: 400 },
    );
    await call(
      "server.resetPassword",
      { token, password: `${password}-new` },
      undefined,
      {
        origin: a.pds.url,
      },
    );
    await call("server.resetPassword", { token, password }, undefined, {
      status: 400,
    });
    await call("server.refreshSession", {}, `Bearer ${a.refreshJwt}`, {
      status: 400,
    });
    const session = await call("server.createSession", {
      identifier: a.email,
      password: `${password}-new`,
    });
    assert.equal(session.did, a.did);
    await call(
      "server.createAppPassword",
      { name: "stale-after-reset" },
      bearer(a),
      {
        origin: a.pds.url,
        status: 403,
      },
    );
    const replacement = await call(
      "server.createAppPassword",
      { name: "fresh-direct-after-reset" },
      bearer(session),
    );
    assert.equal(replacement.name, "fresh-direct-after-reset");
  },
);
integration(
  "PLC signatures require email proof, verify cryptographically, and submit through stock PDS constraints",
  async () => {
    const recovery = await Secp256k1Keypair.create();
    const current = await new plc.Client(config.plcUrl).getLastOp(identity.did);
    await call(
      "identity.signPlcOperation",
      {
        rotationKeys: [recovery.did(), ...current.rotationKeys],
        token: "wrong",
      },
      bearer(identity),
      { origin: identity.pds.url, status: 400 },
    );
    const firstSince = Date.now();
    await call("identity.requestPlcOperationSignature", {}, bearer(identity), {
      origin: identity.pds.url,
    });
    const token = (
      await waitForMailpitCode({ recipient: identity.email, since: firstSince })
    ).code;
    const { operation } = await call(
      "identity.signPlcOperation",
      { rotationKeys: [recovery.did(), ...current.rotationKeys], token },
      bearer(identity),
      { origin: identity.pds.url },
    );
    assert.equal(
      await plc.assureValidSig(current.rotationKeys, operation),
      config.plcRotationKeyDid,
    );
    await call("identity.signPlcOperation", { token }, bearer(identity), {
      status: 400,
    });
    await call("identity.submitPlcOperation", { operation }, bearer(identity));
    const updated = await new plc.Client(config.plcUrl).getLastOp(identity.did);
    assert.deepEqual(updated.rotationKeys, operation.rotationKeys);
    const duplicate = await call(
      "identity.submitPlcOperation",
      { operation },
      bearer(identity),
      { status: 400, strictJson: true },
    );
    assert.equal(duplicate.error, "InvalidRequest");
    assert.equal(
      duplicate.message ===
        `Invalid signature on op: ${JSON.stringify(operation)}`,
      true,
      "Duplicate must preserve the exact unchanged PLC rejection",
    );
    const secondSince = Date.now();
    await call("identity.requestPlcOperationSignature", {}, bearer(identity));
    const migration = await call(
      "identity.signPlcOperation",
      {
        token: (
          await waitForMailpitCode({
            recipient: identity.email,
            since: secondSince,
          })
        ).code,
        services: {
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: config.pds[1].url,
          },
        },
      },
      bearer(identity),
    );
    assert.equal(
      migration.operation.services.atproto_pds.endpoint,
      config.pds[1].url,
    );
    // A hosting PDS must not accept a migration-away operation through its local submit API.
    const rejectedMigration = await call(
      "identity.submitPlcOperation",
      migration,
      bearer(identity),
      { status: 400, strictJson: true },
    );
    assert.equal(rejectedMigration.error, "InvalidRequest");
    assert.equal(
      rejectedMigration.message,
      "Incorrect endpoint on atproto_pds service",
    );
    // Both definitively rejected requests preserve the next ordinary action.
    await call(
      "identity.requestPlcOperationSignature",
      undefined,
      bearer(identity),
    );
    const afterRejections = await new plc.Client(config.plcUrl).getLastOp(
      identity.did,
    );
    assert.equal(
      JSON.stringify(afterRejections) === JSON.stringify(updated),
      true,
      "Both rejections preserve the published operation",
    );
  },
);
integration(
  "entryway resource-status and reserve-key APIs return actual PDS state",
  async () => {
    const status = await call(
      "server.checkAccountStatus",
      undefined,
      bearer(identity),
    );
    assert.equal(status.validDid, true);
    assert.equal(status.activated, true);
    assert.ok(status.repoBlocks > 0);
    assert.equal(typeof status.repoCommit, "string");
    const key = await call("server.reserveSigningKey", { pdsId: "pds2" });
    assert.ok(key.signingKey.startsWith("did:key:"));
    await call("server.reserveSigningKey", { pdsId: "untrusted" }, undefined, {
      status: 400,
    });
  },
);
integration(
  "admin mail/password/email operations authenticate and respect the selected PDS boundary",
  async () => {
    await call(
      "admin.updateAccountPassword",
      { did: adminAccount.did, password },
      admin(config.pds[0]),
      { status: 403 },
    );
    await call(
      "admin.updateAccountPassword",
      { did: adminAccount.did, password: `${password}-admin` },
      admin(adminAccount.pds),
      { origin: adminAccount.pds.url },
    );
    const session = await call("server.createSession", {
      identifier: adminAccount.handle,
      password: `${password}-admin`,
    });
    assert.equal(session.did, adminAccount.did);
    await call(
      "admin.sendEmail",
      {
        recipientDid: adminAccount.did,
        senderDid: config.serviceDid,
        subject: "Spike fixture",
        content: "A local mail delivery test",
      },
      admin(adminAccount.pds),
      { origin: adminAccount.pds.url },
    );
    const messages = db
      .prepare(
        "SELECT value FROM key_value_state WHERE namespace='mail-outbox'",
      )
      .all()
      .map((r) => JSON.parse(r.value));
    assert.ok(
      messages.some(
        (m) =>
          m.recipientDid === adminAccount.did && m.subject === "Spike fixture",
      ),
    );
    const newEmail = `api-${unique}-admin-new@example.com`;
    await call(
      "admin.updateAccountEmail",
      { account: adminAccount.did, email: newEmail },
      admin(adminAccount.pds),
      { origin: adminAccount.pds.url },
    );
    const row = JSON.parse(
      db.prepare("SELECT data FROM accounts WHERE did=?").get(adminAccount.did)
        .data,
    );
    assert.equal(row.email, newEmail);
    assert.equal(row.emailVerified, false);
    await call("server.refreshSession", {}, `Bearer ${session.refreshJwt}`, {
      status: 400,
    });
  },
);
integration(
  "invite allocation/redemption, signup queue, phone proofs and scope references persist",
  async () => {
    const { code } = await call(
      "server.createInviteCode",
      { useCount: 1, forAccount: main.did },
      admin(),
    );
    const own = await call(
      "server.getAccountInviteCodes",
      undefined,
      bearer(main),
      {
        origin: main.pds.url,
      },
    );
    assert.ok(own.codes.some((c) => c.code === code && c.available === 1));
    const phone = "+12025550123";
    await call("temp.requestPhoneVerification", { phoneNumber: phone });
    const invited = await signup("invited", "pds1", {
      inviteCode: code,
      verificationPhone: phone,
      verificationCode: mail(phone, "sms-outbox").otp,
      // signup() requests the email proof immediately before createAccount.
      get emailVerificationCode() {
        return mail(`api-${unique}-invited@example.com`).otp;
      },
    });
    const used = await call(
      "server.getAccountInviteCodes",
      undefined,
      bearer(main),
    );
    assert.equal(
      used.codes.find((c) => c.code === code).uses[0].usedBy,
      invited.did,
    );
    const queue = await call(
      "temp.checkSignupQueue",
      undefined,
      bearer(invited),
      {
        origin: invited.pds.url,
      },
    );
    assert.equal(queue.activated, true);
    const { ref } = await request(config.issuer, "/admin/scope-reference", {
      body: { scope: "atproto repo:org.hypercerts.spike.note?action=create" },
      auth: admin(),
    });
    assert.ok(ref.startsWith("ref:b"));
    const expanded = await request(
      config.issuer,
      `/xrpc/com.atproto.temp.dereferenceScope?scope=${encodeURIComponent(ref)}`,
    );
    assert.equal(
      expanded.scope,
      "atproto repo:org.hypercerts.spike.note?action=create",
    );
    await request(
      config.issuer,
      "/xrpc/com.atproto.temp.dereferenceScope?scope=ref:missing",
      {
        status: 400,
      },
    );
  },
);
integration(
  "standard deactivation, reactivation and challenge-confirmed deletion call stock PDS admin lifecycle",
  async () => {
    const a = await signup("lifecycle");
    await call("server.deactivateAccount", {}, bearer(a), {
      origin: a.pds.url,
    });
    const deactivated = await call("server.createSession", {
      identifier: a.email,
      password,
    });
    assert.equal(deactivated.active, false);
    await call("server.activateAccount", {}, bearer(deactivated), {
      origin: a.pds.url,
    });
    await call("server.requestAccountDelete", {}, bearer(deactivated), {
      origin: a.pds.url,
    });
    const token = mail(a.email).token;
    await call(
      "server.deleteAccount",
      { did: a.did, token, password: "wrong-password" },
      undefined,
      { status: 403 },
    );
    await call(
      "server.deleteAccount",
      { did: a.did, token, password },
      undefined,
      {
        origin: a.pds.url,
      },
    );
    const row = JSON.parse(
      db.prepare("SELECT data FROM accounts WHERE did=?").get(a.did).data,
    );
    assert.equal(row.status, "deleted");
    await call(
      "server.createSession",
      { identifier: a.email, password },
      undefined,
      {
        status: 403,
      },
    );
  },
);

integration(
  "XRPC createAccount migrates a managed DID and returns fresh target-PDS session credentials",
  async () => {
    const a = await signup("migrate-api");
    const record = await call(
      "repo.createRecord",
      {
        repo: a.did,
        collection: "org.hypercerts.spike.note",
        validate: false,
        record: {
          $type: "org.hypercerts.spike.note",
          text: "Migration through entryway XRPC",
        },
      },
      bearer(a),
      { origin: a.pds.url },
    );
    await request(config.issuer, "/migration/request", {
      body: { pdsId: "pds2" },
      auth: bearer(a),
    });
    const token = mail(a.email).token;
    await call(
      "server.createAccount",
      { did: identity.did, pdsId: "pds2", token },
      bearer(a),
      {
        status: 403,
      },
    );
    const moved = await call(
      "server.createAccount",
      { did: a.did, pdsId: "pds2", token },
      bearer(a),
    );
    assert.equal(moved.did, a.did);
    assert.equal(moved.migration.status, "complete");
    assert.equal(moved.migration.pdsId, "pds2");
    const session = await call("server.getSession", undefined, bearer(moved), {
      origin: config.pds[1].url,
    });
    assert.equal(session.did, a.did);
    const copy = await request(
      config.pds[1].url,
      `/xrpc/com.atproto.repo.getRecord?repo=${a.did}&collection=org.hypercerts.spike.note&rkey=${record.uri.split("/").at(-1)}`,
    );
    assert.equal(copy.cid, record.cid);
    const status = await request(config.issuer, "/migration/status", {
      body: {},
      auth: bearer(moved),
    });
    assert.equal(status.phase, "complete");
    assert.equal(
      db.prepare("SELECT pds_id FROM accounts WHERE did=?").get(a.did).pds_id,
      "pds2",
    );
  },
);
