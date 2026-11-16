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

export async function composeIncomingArrival({
  db,
  arrivals,
  config,
  accounts,
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
      backend: (saved) => {
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
          reserveSigningKey: () => transport.reserveSigningKey(saved.did),
        };
      },
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
  return {
    ...admission,
    prepareArrival,
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
