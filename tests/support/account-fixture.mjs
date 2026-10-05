import { Secp256k1Keypair } from "@atproto/crypto";
import { createAccounts } from "../../dist/src/compose-accounts.mjs";
import { openDatabase } from "../../dist/src/database/sqlite/connection.mjs";

export async function fixture(t, reply) {
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  const config = {
    plcRotationKeyHex: Buffer.from(await rotation.export()).toString("hex"),
    plcUrl: "https://plc.invalid",
    handleDomains: [".entryway.atmosbox.test"],
    pds: [
      {
        id: "pds1",
        url: "https://pds1.entryway.atmosbox.test",
        internalUrl: "http://pds1:3000",
        did: "did:web:pds1.entryway.atmosbox.test",
        adminPassword: "test-admin",
      },
    ],
  };
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, body });
    const response = reply?.({ method, body, calls });
    if (response)
      return Response.json(response.body ?? {}, {
        status: response.status ?? 200,
      });
    if (method === "com.atproto.server.reserveSigningKey")
      return Response.json({
        signingKey: (await Secp256k1Keypair.create()).did(),
      });
    if (method === "com.atproto.repo.describeRepo")
      return Response.json({ error: "RepoNotFound" }, { status: 404 });
    return Response.json({});
  };
  const db = openDatabase(":memory:");
  t.after(() => {
    globalThis.fetch = previous;
    db.close();
  });
  const accounts = await createAccounts({ db, config });
  return { db, accounts, calls };
}
export const alice = {
  email: "alice@example.com",
  handle: "alice.entryway.atmosbox.test",
  pdsId: "pds1",
};
