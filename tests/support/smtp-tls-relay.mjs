// Run inside the managed test container. All certificates and credentials are ephemeral.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMTPServer } from "smtp-server";

const directory = await mkdtemp(join(tmpdir(), "entryway-smtp-"));
const key = join(directory, "key.pem");
const cert = join(directory, "cert.pem");
const generated = spawnSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
  ],
  { stdio: "ignore" },
);
if (generated.status !== 0) throw new Error("Certificate generation failed");
let deliveries = 0;
const server = new SMTPServer({
  secure: true,
  key: await readFile(key),
  cert: await readFile(cert),
  onAuth(auth, _session, callback) {
    if (auth.username === "test-user" && auth.password === "test-password")
      callback(null, { user: "test-user" });
    else callback(new Error("Authentication failed"));
  },
  onData(stream, _session, callback) {
    stream.resume();
    stream.on("end", () => {
      deliveries++;
      callback();
    });
  },
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, resolve);
});
const port = server.server.address().port;
let anonymousDeliveries = 0;
const anonymousServer = new SMTPServer({
  secure: true,
  key: await readFile(key),
  cert: await readFile(cert),
  authOptional: true,
  disabledCommands: ["AUTH"],
  onData(stream, _session, callback) {
    stream.resume();
    stream.on("end", () => {
      anonymousDeliveries++;
      callback();
    });
  },
});
await new Promise((resolve, reject) => {
  anonymousServer.once("error", reject);
  anonymousServer.listen(0, resolve);
});
const anonymousPort = anonymousServer.server.address().port;
const client = `import { createSmtpMailTransport } from './dist/src/mail/smtp.js';
const transport = createSmtpMailTransport({ mode: 'tls', host: 'localhost', port: Number(process.env.TEST_PORT), sender: 'sender@example.test', user: process.env.TEST_USER, password: process.env.TEST_PASSWORD });
try { await transport.deliver({ recipient: 'recipient@example.test', subject: 'test', text: 'test', html: '<p>test</p>' }); process.exit(0); } catch (error) { process.exit(error.outcome === 'permanent' ? 2 : 1); }`;
async function run(trusted, password, user = "test-user", relayPort = port) {
  const env = {
    ...process.env,
    TEST_PASSWORD: password,
    TEST_USER: user,
    TEST_PORT: String(relayPort),
  };
  if (trusted) env.NODE_EXTRA_CA_CERTS = cert;
  else delete env.NODE_EXTRA_CA_CERTS;
  const child = spawn(process.execPath, ["--input-type=module", "-e", client], {
    env,
    stdio: "ignore",
  });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}
try {
  assert.equal(await run(true, "test-password"), 0);
  assert.equal(await run(false, "test-password"), 1);
  assert.equal(await run(true, "wrong-password"), 2);
  assert.equal(await run(true, "test-password", "wrong-user"), 2);
  assert.notEqual(
    await run(true, "test-password", "test-user", anonymousPort),
    0,
  );
  assert.equal(deliveries, 1);
  assert.equal(anonymousDeliveries, 0);
  console.log(
    "SMTP TLS relay: trusted authentication accepted; untrusted certificate, wrong credentials and missing AUTH rejected",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => anonymousServer.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
