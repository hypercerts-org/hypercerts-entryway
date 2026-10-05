import { randomBytes } from "node:crypto";

import { fail, emailAddress } from "../../accounts/input.mjs";

export async function createInvites({ db, config, accounts }) {
  const createInviteCode = ({ useCount, forAccount = "admin" }) => {
    if (!Number.isInteger(useCount) || useCount < 1 || useCount > 1000)
      fail("InvalidRequest", "useCount must be between 1 and 1000");
    if (
      forAccount !== "admin" &&
      (!accounts.get(forAccount) ||
        accounts.get(forAccount).status === "deleted")
    )
      fail("AccountNotFound", "Account not found");
    const code = `spike-${randomBytes(12).toString("hex")}`;
    db.set("entryway:invites", code, {
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
  // Preserve pre-fix spike invite balances if an existing volume contains them.
  // Each reservation already decremented the old available field exactly once.
  db.transact(() => {
    const reservations = db.list("entryway:invite-reservations");
    for (const { key, value } of db.list("entryway:invites")) {
      if (Number.isInteger(value.remaining)) continue;
      const claimed = reservations.filter(
        ({ value: reservation }) => reservation.code === key,
      ).length;
      db.set("entryway:invites", key, {
        ...value,
        available: value.available + claimed,
        remaining: value.available,
      });
    }
  });
  const getAccountInviteCodes = (row, { includeUsed = true } = {}) => ({
    codes: db
      .list("entryway:invites")
      .map(({ value }) => value)
      .filter(
        (c) =>
          c.forAccount === row.did &&
          !c.disabled &&
          (includeUsed || c.remaining > 0),
      )
      .map(({ remaining, ...code }) => code),
  });
  const reserveInvite = (code, email) =>
    db.transact(() => {
      email = emailAddress(email);
      const reserved = db.get("entryway:invite-reservations", email);
      if (reserved) {
        if (code && reserved.code !== code)
          fail("InvalidInviteCode", "Signup already reserved another invite");
        const original = db.get("entryway:invites", reserved.code);
        if (!original || original.disabled)
          fail("InvalidInviteCode", "Invite code is invalid");
        if (reserved.did && accounts.get(email)?.did !== reserved.did)
          fail(
            "InvalidInviteCode",
            "The invitation was already used by another account",
          );
        // A reconciliation retry has the verified email and recorded assignment,
        // but need not retain or re-present its original invitation secret.
        return;
      }
      if (!code && !config.inviteCodeRequired) return;
      const row = db.get("entryway:invites", code);
      if (!row || row.disabled)
        fail("InvalidInviteCode", "Invite code is invalid");
      if (row.remaining < 1)
        fail("InvalidInviteCode", "Invite code is exhausted");
      db.set("entryway:invites", code, {
        ...row,
        remaining: row.remaining - 1,
      });
      db.set("entryway:invite-reservations", email, {
        code,
        email,
        at: new Date(),
      });
    });
  const completeInvite = (row) =>
    db.transact(() => {
      const reserved = db.get("entryway:invite-reservations", row.email);
      if (!reserved) return;
      if (reserved.did) {
        if (reserved.did !== row.did)
          fail(
            "InvalidInviteCode",
            "The invitation was already used by another account",
          );
        return;
      }
      const invite = db.get("entryway:invites", reserved.code);
      if (!invite)
        fail("InvalidInviteCode", "The reserved invitation could not be found");
      db.set("entryway:invites", reserved.code, {
        ...invite,
        uses: [
          ...invite.uses,
          { usedBy: row.did, usedAt: new Date().toISOString() },
        ],
      });
      db.set("entryway:invite-reservations", row.email, {
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
