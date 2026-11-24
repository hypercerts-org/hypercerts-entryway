// Create test sessions through the same approval and exchange storage boundary.
export async function createApprovedOAuthToken(store, id, data, refreshToken) {
  const code = data.code ?? `fixture-code-${id}`;
  const clientId = data.clientId ?? "fixture-client";
  await store.createRequest(`fixture-request-${id}`, { clientId });
  await store.updateRequest(`fixture-request-${id}`, { did: data.did, code });
  await store.runExchange(async () => {
    await store.consumeRequestCode(code);
    await store.createToken(id, { ...data, clientId, code }, refreshToken);
  });
}
