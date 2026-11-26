import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";

const [host, certPath, identity, publicCaPath, mode] = process.argv.slice(2);
const ca = readFileSync(certPath);
const publicCa = readFileSync(publicCaPath);
const agent = new https.Agent({ ca, keepAlive: true, maxSockets: 1 });
function request(options) {
  return new Promise((resolve, reject) => {
    const outbound = https.request(
      { timeout: 3000, ...options },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString(),
            socket: response.socket ?? outbound.socket,
          }),
        );
        response.on("error", reject);
      },
    );
    outbound.on("timeout", () => outbound.destroy(Error("timeout")));
    outbound.on("error", reject);
    outbound.end();
  });
}
const managed = (path, method, headers = {}) =>
  request({
    host,
    port: 3444,
    path,
    method,
    headers: { host: "cluster1.atmosbox.test", ...headers },
    agent,
    ca,
    servername: "controller-gateway.test",
  });
try {
  if (mode === "stale" || mode === "replacement") {
    const publicResult = await request({
      host: "cluster1.atmosbox.test",
      port: 443,
      path: "/xrpc/com.atproto.server.describeServer",
      method: "GET",
      ca: publicCa,
      agent: false,
    });
    assert.notEqual(publicResult.status, 200);
    const nonce = randomBytes(32).toString("base64url");
    if (mode === "replacement") {
      const result = await managed("/_controller/challenge", "POST", {
        "x-controller-nonce": nonce,
      });
      assert.deepEqual(JSON.parse(result.body), { identity, nonce });
      assert.equal(
        (await managed("/xrpc/com.atproto.server.describeServer", "GET"))
          .status,
        200,
      );
      console.log("Replacement gateway is live but old public pin refused it");
    } else {
      try {
        const result = await managed("/_controller/challenge", "POST", {
          "x-controller-nonce": nonce,
        });
        assert.notEqual(result.status, 200);
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
      }
      console.log("Stale public and managed routes refused");
    }
  } else {
    await assert.rejects(
      request({
        host,
        port: 3444,
        path: "/_controller/challenge",
        method: "POST",
        headers: {
          "x-controller-nonce": randomBytes(32).toString("base64url"),
        },
        ca: publicCa,
        servername: "controller-gateway.test",
        agent: false,
      }),
    );
    const publicResult = await request({
      host: "cluster1.atmosbox.test",
      port: 443,
      path: "/xrpc/com.atproto.server.describeServer",
      method: "GET",
      ca: publicCa,
      agent: false,
    });
    assert.equal(publicResult.status, 200);
    const nonce = randomBytes(32).toString("base64url");
    const challenge = await managed("/_controller/challenge", "POST", {
      "x-controller-nonce": nonce,
    });
    assert.deepEqual(JSON.parse(challenge.body), { identity, nonce });
    const read = await managed(
      "/xrpc/com.atproto.server.describeServer",
      "GET",
    );
    assert.equal(read.status, 200);
    assert.equal(challenge.socket, read.socket);
    assert.equal(
      (await managed("/xrpc/com.atproto.server.describeServer", "GET")).status,
      403,
    );
    assert.equal(
      (await managed("/xrpc/com.atproto.server.createAccount", "POST")).status,
      403,
    );
    console.log(
      "Public Caddy route and same-connection managed TLS probe passed",
    );
  }
} finally {
  agent.destroy();
}
