import { getPdsJson } from "./registry-http.mjs";

export async function probePdsHealth(revision, verifier, deadlineMs) {
  const probe = async (origin) =>
    !(
      await getPdsJson(origin, "/xrpc/_health", verifier, undefined, deadlineMs)
    ).reason;
  if (revision.publicUrl === revision.internalUrl) {
    const ok = await probe(revision.publicUrl);
    return { publicOk: ok, internalOk: ok };
  }
  const [publicOk, internalOk] = await Promise.all([
    probe(revision.publicUrl),
    probe(revision.internalUrl),
  ]);
  return { publicOk, internalOk };
}
