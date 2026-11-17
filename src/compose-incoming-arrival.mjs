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
      pdsDid: pds.did,
      issuer: config.serviceDid,
      jwtJwk: config.jwtJwk,
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
    verify: createIncomingAuthorization({
      serviceDid: config.serviceDid,
      readDirectory: (did) => accounts.plcClient.getDocument(did),
    }),
    client: accounts.plcClient,
  });
  // Dormant internal callables: browser authentication supplies the saved user,
  // never claim.resource or a user ID from the request body.
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
    // Tracked migration credentials and the one guarded activation. Dormant:
    // plan 012 injects these into routes, XRPC and the stock callback.
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
