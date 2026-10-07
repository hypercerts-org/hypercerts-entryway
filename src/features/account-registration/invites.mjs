import { randomBytes } from "node:crypto";

import { fail, emailAddress } from "../../accounts/input.mjs";

export async function createInvites({ db, config, accounts }) {
  const createInviteCode = async ({ useCount, forAccount = "admin" }) => {
    if (!Number.isInteger(useCount) || useCount < 1 || useCount > 1000)
      fail("InvalidRequest", "useCount must be between 1 and 1000");
    if (
      forAccount !== "admin" &&
      (!(await accounts.get(forAccount)) ||
        (await accounts.get(forAccount)).status === "deleted")
    )
      fail("AccountNotFound", "Account not found");
    const code = `spike-${randomBytes(12).toString("hex")}`;
    await db.set("entryway:invites", code, {
      code,
      // Stock invite.available is total capacity; uses records completed claims.
      available: useCount,
      remaining: useCount,
      disabled: false,
      forAccount,
      createdBy: "admin",
      createdAt: new Date().toISOString(),
      uses: [],
    });
    return { code };
  };
  const getAccountInviteCodes = async (row, { includeUsed = true } = {}) => ({
    codes: (await db.list("entryway:invites"))
      .map(({ value }) => value)
      .filter(
        (c) =>
          c.forAccount === row.did &&
          !c.disabled &&
          (includeUsed || c.remaining > 0),
      )
      .map(({ remaining, ...code }) => code),
  });
  const reserveInvite = async (code, email) =>
    await db.transact(async () => {
      email = emailAddress(email);
      const reserved = await db.get("entryway:invite-reservations", email);
      if (reserved) {
        if (code && reserved.code !== code)
          fail("InvalidInviteCode", "Signup already reserved another invite");
        const original = await db.get("entryway:invites", reserved.code);
        if (!original || original.disabled)
          fail("InvalidInviteCode", "Invite code is invalid");
        if (reserved.did && (await accounts.get(email))?.did !== reserved.did)
          fail(
            "InvalidInviteCode",
            "The invitation was already used by another account",
          );
        // A reconciliation retry has the verified email and recorded assignment,
        // but need not retain or re-present its original invitation secret.
        return;
      }
      if (!code && !config.inviteCodeRequired) return;
      const row = await db.get("entryway:invites", code);
      if (!row || row.disabled)
        fail("InvalidInviteCode", "Invite code is invalid");
      if (row.remaining < 1)
        fail("InvalidInviteCode", "Invite code is exhausted");
      await db.set("entryway:invites", code, {
        ...row,
        remaining: row.remaining - 1,
      });
      await db.set("entryway:invite-reservations", email, {
        code,
        email,
        at: new Date(),
      });
    });
  const completeInvite = async (row) =>
    await db.transact(async () => {
      const reserved = await db.get("entryway:invite-reservations", row.email);
      if (!reserved) return;
      if (reserved.did) {
        if (reserved.did !== row.did)
          fail(
            "InvalidInviteCode",
            "The invitation was already used by another account",
          );
        return;
      }
      const invite = await db.get("entryway:invites", reserved.code);
      if (!invite)
        fail("InvalidInviteCode", "The reserved invitation could not be found");
      await db.set("entryway:invites", reserved.code, {
        ...invite,
        uses: [
          ...invite.uses,
          { usedBy: row.did, usedAt: new Date().toISOString() },
        ],
      });
      await db.set("entryway:invite-reservations", row.email, {
        ...reserved,
        did: row.did,
      });
    });
  return {
    createInviteCode,
    getAccountInviteCodes,
    reserveInvite,
    completeInvite,
  };
}
