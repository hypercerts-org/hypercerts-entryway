import { randomInt, createHmac, timingSafeEqual } from "node:crypto";

import { fail } from "./input.mjs";

export async function createProtocolChallenges({ db, config, accounts }) {
  const challengeDigest = (purpose, subject, value) =>
    createHmac("sha256", config.betterAuthSecret)
      .update(
        JSON.stringify([
          "entryway-extra-code/v1",
          purpose,
          subject,
          String(value),
        ]),
      )
      .digest("hex");
  const rateLimit = (key, limit = 5, window = 600_000) => {
    const now = Date.now();
    const old = db.get("entryway:limits", key);
    const row =
      old && old.until > now ? old : { count: 0, until: now + window };
    if (row.count >= limit)
      fail("RateLimitExceeded", "Please wait before trying again", 429);
    db.set("entryway:limits", key, { ...row, count: row.count + 1 });
  };
  const sendCode = (purpose, subject, destination, channel = "email", did) => {
    rateLimit(`${purpose}:${subject}`);
    const otp = String(randomInt(10_000_000, 100_000_000));
    db.set("entryway:challenges", `${purpose}:${subject}`, {
      hash: challengeDigest(purpose, subject, otp),
      attempts: 0,
      expiresAt: Date.now() + 600_000,
      ...(did ? { did, version: db.get("security:versions", did) ?? 0 } : {}),
    });
    db.set(channel === "email" ? "outbox" : "sms-outbox", destination, {
      [channel === "email" ? "email" : "phoneNumber"]: destination,
      otp,
      type: purpose,
      createdAt: new Date(),
    });
    return {};
  };
  const consumeCode = (purpose, subject, code) =>
    db.transact(() => {
      const key = `${purpose}:${subject}`;
      const row = db.get("entryway:challenges", key);
      if (!row || row.expiresAt <= Date.now() || row.attempts >= 5)
        return false;
      // Challenges written before version binding was introduced must not survive
      // a security upgrade and become reusable after an account reset.
      if (
        purpose === "plc-operation" &&
        (!row.did || !Number.isInteger(row.version))
      )
        return false;
      if (row.did) {
        const current = accounts.get(row.did);
        if (
          !current ||
          current.did !== row.did ||
          ["deleted", "provisioning"].includes(current.status) ||
          row.version !== (db.get("security:versions", row.did) ?? 0)
        )
          return false;
      }
      const valid =
        typeof code === "string" &&
        timingSafeEqual(
          Buffer.from(row.hash, "hex"),
          Buffer.from(challengeDigest(purpose, subject, code), "hex"),
        );
      if (valid) db.delete("entryway:challenges", key);
      else
        db.set("entryway:challenges", key, {
          ...row,
          attempts: row.attempts + 1,
        });
      return valid;
    });
  const requireCode = (purpose, subject, code) => {
    if (!consumeCode(purpose, subject, code))
      fail("InvalidToken", "Code is invalid, expired or already used");
  };
  return { rateLimit, sendCode, requireCode };
}
