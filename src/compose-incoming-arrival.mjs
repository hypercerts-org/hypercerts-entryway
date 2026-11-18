import { createDurableArrivalProvisioning } from "./features/external-migration/provision-arrival.js";
import { createOperationOwnershipStore } from "./database/drizzle/operation-ownership.js";
import { DomainError } from "./accounts/errors.js";
import { createArrivalAdmission } from "./database/arrival-admission.js";
import { createInvites } from "./features/account-registration/invites.mjs";
import { createIncomingPreparation } from "./features/external-migration/prepare-arrival.js";
import { createProtocolChallenges } from "./accounts/challenges.mjs";
import { createPdsAccountClient } from "./pds/account-client.mjs";
import { ArrivalPdsClient } from "./pds/arrival-client.js";
import { createIncomingAuthorization } from "./features/external-migration/incoming-authorization.js";
import { createArrivalLifecycle } from "./features/external-migration/manage-arrival.js";
import { createAuthenticatedArrival } from "./features/external-migration/submit-handoff.js";
import { createArrivalCredentials } from "./features/external-migration/arrival-credentials.js";
import { createArrivalActivation } from "./features/external-migration/activate-arrival.js";
import { createToolAdmission } from "./features/external-migration/tool-admission.js";
import { summarizeArrival } from "./features/external-migration/arrival-summary.js";
import { createArrivalStorage } from "./database/drizzle/migration-arrival.js";

/** Production arrival persistence over the application's account storage. The
 * placed account, saved-user binding and the later `provisioning` -> `active`
 * flip all go through the reviewed account authority, in the arrival's own
 * transactions. */
export function createIncomingArrivalStorage({ db, config, accounts }) {
  const storage = accounts.storage;
  return createArrivalStorage(db, config.pds, {
    readAccount: (did) => storage.getByDid(did),
    readBinding: (did) => storage.getVerifiedBinding(did),
    reserveEmailClaim: (...args) => storage.reserveEmail(...args),
    reserveHandleClaim: (...args) => storage.reserveHandle(...args),
    recordSavedUserBinding: (did, userId) =>
      storage.bindPlacedAccount(did, userId),
    activatePlacedAccount: (did) => storage.activatePlacedAccount(did),
    insertPlacedAccount: (input) =>
      storage.insertAccount(
        {
          did: input.did,
          email: input.email,
          emailVerified: true,
          handle: input.handle,
          pdsId: input.pdsId,
          pdsUrl: input.pdsUrl,
          status: "provisioning",
          createdAt: new Date().toISOString(),
        },
        input.userId,
      ),
  });
}

/** The application's incoming-arrival feature: production storage, the real
 * browser authentication/CSRF producers and the one composition below. */
export async function createIncomingArrival({
  db,
  config,
  accounts,
  legacy,
  oauth,
}) {
  return composeIncomingArrival({
    db,
    arrivals: createIncomingArrivalStorage({ db, config, accounts }),
    config,
    accounts,
    legacy,
    authentication: oauth,
    browserFlow: {
      loadBrowser: (request) => oauth.loadBrowser(request, request.res),
      checkCsrf: oauth.checkCsrf,
    },
  });
}

export async function composeIncomingArrival({
  db,
  arrivals,
  config,
  accounts,
  legacy,
  authentication,
  browserFlow,
}) {
  const invitation = await createInvites({ db, config, accounts });
  const { rateLimit } = await createProtocolChallenges({
    db,
    config,
    accounts,
  });
  const { choosePds } = await createPdsAccountClient({ config, accounts });
  const placement = (pdsId) => config.pds.find((pds) => pds.id === pdsId);
  const arrivalBackend = (saved) => {
    const pds = choosePds(saved.pdsId);
    if (pds.url !== saved.endpoint)
      throw new DomainError(
        "OperationConflict",
        409,
        "Arrival placement changed",
      );
    const transport = new ArrivalPdsClient({
      endpoint: saved.endpoint,
      did: saved.did,
    });
    const authorization = () =>
      `Basic ${Buffer.from(`admin:${pds.adminPassword}`).toString("base64")}`;
    return {
      inspect: () => transport.getAccountInfo(authorization),
      create: (operation) =>
        transport.createAccount({
          did: saved.did,
          handle: saved.handle,
          operation,
        }),
      pause: () => transport.pauseAccount(authorization),
      activate: () => transport.activateAccount(authorization),
      reserveSigningKey: () => transport.reserveSigningKey(saved.did),
    };
  };
  const prepareArrival = createIncomingPreparation({
    arrivals,
    authentication,
    checkCsrf: browserFlow.checkCsrf,
    loadBrowser: browserFlow.loadBrowser,
    rateLimit,
    choosePds,
    plcClient: accounts.plcClient,
    entrywayKey: accounts.plcSigner.publicKey(),
    entrywayDid: config.serviceDid,
  });
  const lifecycle = createArrivalLifecycle({
    arrivals,
    ownership: accounts.ownership,
    authentication,
    checkCsrf: browserFlow.checkCsrf,
    loadBrowser: browserFlow.loadBrowser,
    rateLimit,
  });
  const verify = createIncomingAuthorization({
    serviceDid: config.serviceDid,
    readDirectory: (did) => accounts.plcClient.getDocument(did),
  });
  const admission = createArrivalAdmission({ db, arrivals, invitation });
  const authenticated = createAuthenticatedArrival({
    arrivals,
    ownership: accounts.ownership,
    transact: (work) => db.transact(work),
    admitCreation: admission.admitCreation,
    provision: createDurableArrivalProvisioning({
      arrivals,
      ownership: accounts.ownership,
      receipts: createOperationOwnershipStore(db),
      client: accounts.plcClient,
      signer: accounts.plcSigner,
      bindPending: admission.bindPending,
      backend: arrivalBackend,
    }),
    verify,
    client: accounts.plcClient,
    digestKey: config.betterAuthSecret,
  });
  // Browser callables: browser authentication supplies the saved user, never
  // claim.resource or a user ID from the request body.
  const savedUser = async (request) => {
    const browser = await browserFlow.loadBrowser(request);
    browserFlow.checkCsrf(request, browser);
    const principal = await authentication.requireSession(request);
    if (!principal?.emailVerified)
      throw new DomainError(
        "AccountMismatch",
        403,
        "A verified saved browser owner is required",
      );
    return principal.userId;
  };
  const credentials = createArrivalCredentials({
    arrivals,
    ownership: accounts.ownership,
    transact: (work) => db.transact(work),
    signer: legacy.arrivalSessions,
    readAccount: (did) => accounts.storage.getByDid(did),
    readBinding: (did) => accounts.storage.getVerifiedBinding(did),
    readDocument: (did) => accounts.plcClient.getDocument(did),
    placement,
    authentication,
    checkCsrf: browserFlow.checkCsrf,
    loadBrowser: browserFlow.loadBrowser,
    rateLimit,
  });
  // Tool surfaces carry no cookie. Accepted by both developers: the
  // current arrival code selects the arrival and its saved user (see
  // tool-admission.ts); browser surfaces below keep the browser-bound forms.
  const toolAdmission = createToolAdmission({
    arrivals,
    ownership: accounts.ownership,
    admit: authenticated.admit,
    continueCreation: authenticated.continueCreation,
    issueCreationSession: credentials.issueCreationSession,
    // An exact replay re-sends the same password, so an existing credential on
    // the arrival's own account is already this request's. The install itself
    // is conditional in one authority transaction, so concurrent replays and a
    // late installer after activation cannot overwrite or revoke anything.
    setArrivalPassword: async ({
      did,
      operationId,
      userId,
      password,
      owner,
      version,
    }) => {
      if (!(await legacy.hasPassword(did)))
        await legacy.installInitialPassword(did, password, {
          isPending: (account) =>
            accounts.storage.hasPendingExternalMigration(account.did),
          // Inside the install transaction: the arrival's claim fence and its
          // saved state must still be the ones this execution resumed.
          assertOwner: async () => {
            await db.assertOperationFence(owner);
            const current = await arrivals.readArrivalAggregate(
              operationId,
              userId,
            );
            if (
              !current ||
              current.arrival.version !== version ||
              current.arrival.cancelledAt !== null ||
              current.progress.completedAt !== null
            )
              throw new DomainError(
                "OperationLeaseLost",
                409,
                "The arrival changed; retry after reconciliation",
              );
          },
        });
    },
  });
  const activation = createArrivalActivation({
    arrivals,
    ownership: accounts.ownership,
    receipts: createOperationOwnershipStore(db),
    transact: (work) => db.transact(work),
    plcClient: accounts.plcClient,
    accounts: {
      getByDid: (did) => accounts.storage.getByDid(did),
      getVerifiedBinding: (did) => accounts.storage.getVerifiedBinding(did),
    },
    placement,
    backend: arrivalBackend,
    authorizeAccess: credentials.identifyArrivalAccess,
    assertCredentialLive: (familyId) =>
      legacy.arrivalSessions.assertLive(familyId),
    authentication,
    checkCsrf: browserFlow.checkCsrf,
    loadBrowser: browserFlow.loadBrowser,
    rateLimit,
  });
  return {
    ...admission,
    prepareArrival,
    submitIncomingHandoff: toolAdmission.submitHandoff,
    createIncomingAccount: toolAdmission.createAccount,
    /** Secret-free state for the saved user's own arrival; a read needs the
     * verified session but no CSRF token. Another user's arrival is not found. */
    describeArrival: async (request, operationId) => {
      const principal = await authentication.requireSession(request);
      if (!principal?.emailVerified)
        throw new DomainError(
          "AccountMismatch",
          403,
          "A verified saved browser owner is required",
        );
      const aggregate =
        typeof operationId === "string" && operationId.length <= 200
          ? await arrivals.readArrivalAggregate(operationId, principal.userId)
          : null;
      if (!aggregate)
        throw new DomainError("AccountNotFound", 404, "Arrival not found");
      return summarizeArrival(aggregate);
    },
    /** A fresh sign-in code for the saved user's own email, on the existing
     * challenge budget. */
    sendArrivalCode: async (request) => {
      const userId = await savedUser(request);
      const principal = await authentication.requireSession(request);
      await rateLimit(`incoming-code:${userId}`);
      await authentication.sendSignInCode(principal.email);
      return {};
    },
    // Tracked migration credentials and the one guarded activation.
    issueArrivalSession: async (request, operationId, expectedVersion) =>
      credentials.issueArrivalSession(
        await savedUser(request),
        operationId,
        expectedVersion,
      ),
    issueCreationSession: credentials.issueCreationSession,
    refreshArrivalSession: credentials.refreshArrivalSession,
    recoverArrivalSession: credentials.recoverArrivalSession,
    authorizeArrivalAccess: credentials.authorizeArrivalAccess,
    activateArrivalAsUser: activation.activateArrivalAsUser,
    activateArrivalWithCredential: activation.activateArrivalWithCredential,
    renewArrival: lifecycle.renew,
    cancelArrival: lifecycle.cancel,
    admitIncoming: async (request, input) =>
      authenticated.admit({
        ...input,
        userId: await savedUser(request),
      }),
    reconcileArrival: async (request, operationId) =>
      authenticated.reconcile({
        operationId,
        userId: await savedUser(request),
      }),
    continueCreation: async (request, operationId) =>
      authenticated.continueCreation({
        operationId,
        userId: await savedUser(request),
      }),
    continueHandoff: async (request, operationId) =>
      authenticated.continueHandoff({
        operationId,
        userId: await savedUser(request),
      }),
  };
}
