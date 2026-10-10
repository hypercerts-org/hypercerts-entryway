import { createProtocolChallenges } from "./accounts/challenges.mjs";
import { createPdsAccountClient } from "./pds/account-client.mjs";
import { createSignupProof } from "./features/account-registration/signup-proof.mjs";
import { createPlcOperations } from "./plc/operations.js";
import { createInvites } from "./features/account-registration/invites.mjs";
import { createScopeReferences } from "./features/oauth-authorization/scope-reference.mjs";
import { createAdminMessage } from "./mail/admin-message.mjs";

export async function createProtocolOperations({
  db,
  config,
  accounts,
  plcMail,
}) {
  const operations = {};
  Object.assign(
    operations,
    await createProtocolChallenges({
      db,
      config,
      accounts,
      plcMail,
      ...operations,
    }),
  );
  Object.assign(
    operations,
    await createPdsAccountClient({ db, config, accounts, ...operations }),
  );
  Object.assign(
    operations,
    await createSignupProof({ db, config, accounts, ...operations }),
  );
  Object.assign(
    operations,
    await createPlcOperations({
      db,
      config,
      accounts,
      custody: accounts.custody,
      ...operations,
    }),
  );
  Object.assign(
    operations,
    await createInvites({ db, config, accounts, ...operations }),
  );
  Object.assign(
    operations,
    await createScopeReferences({ db, config, accounts, ...operations }),
  );
  Object.assign(
    operations,
    await createAdminMessage({ db, config, accounts, ...operations }),
  );
  return {
    ...operations,
    checkAccountStatus: (row) =>
      operations.pdsCall(row, "com.atproto.server.checkAccountStatus"),
  };
}
