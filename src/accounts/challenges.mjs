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
  const rateLimit = async (key, limit = 5, window = 600_000) =>
    db.transact(async () => {
      const now = Date.now();
      const old = await db.get("entryway:limits", key);
      const row =
        old && old.until > now ? old : { count: 0, until: now + window };
      if (row.count >= limit)
        fail("RateLimitExceeded", "Please wait before trying again", 429);
      await db.set("entryway:limits", key, { ...row, count: row.count + 1 });
    });
  const sendCode = async (purpose, subject, destination, channel, did) =>
    db.transact(async () => {
      const deliveryChannel = channel === undefined ? "email" : channel;
      await rateLimit(`${purpose}:${subject}`);
      const otp = String(randomInt(10_000_000, 100_000_000));
      await db.set("entryway:challenges", `${purpose}:${subject}`, {
        hash: challengeDigest(purpose, subject, otp),
        attempts: 0,
        expiresAt: Date.now() + 600_000,
        ...(did
          ? { did, version: (await db.get("security:versions", did)) ?? 0 }
          : {}),
      });
      await db.set(
        deliveryChannel === "email" ? "outbox" : "sms-outbox",
        destination,
        {
          [deliveryChannel === "email" ? "email" : "phoneNumber"]: destination,
          otp,
          type: purpose,
          createdAt: new Date(),
        },
      );
      return {};
    });
  const consumeCode = async (purpose, subject, code) =>
    await db.transact(async () => {
      const key = `${purpose}:${subject}`;
      const row = await db.get("entryway:challenges", key);
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
        const current = await accounts.get(row.did);
        if (
          !current ||
          current.did !== row.did ||
          ["deleted", "provisioning"].includes(current.status) ||
          row.version !== ((await db.get("security:versions", row.did)) ?? 0)
        )
          return false;
      }
      const valid =
        typeof code === "string" &&
        timingSafeEqual(
          Buffer.from(row.hash, "hex"),
          Buffer.from(challengeDigest(purpose, subject, code), "hex"),
        );
      if (valid) await db.delete("entryway:challenges", key);
      else
        await db.set("entryway:challenges", key, {
          ...row,
          attempts: row.attempts + 1,
        });
      return valid;
    });
  const requireCode = async (purpose, subject, code) => {
    if (!(await consumeCode(purpose, subject, code)))
      fail("InvalidToken", "Code is invalid, expired or already used");
  };
  return { rateLimit, sendCode, requireCode };
}
