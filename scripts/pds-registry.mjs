#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";

async function protectedFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65_536)
      throw Error("InvalidProtectedInput");
    const buffer = Buffer.alloc(65_537);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 65_536) throw Error("InvalidProtectedInput");
    return buffer.subarray(0, used).toString("utf8");
  } finally {
    await file.close();
  }
}
function argumentsFor(argv) {
  const [command, ...rest] = argv;
  if (
    ![
      "stage",
      "phase",
      "activate",
      "lifecycle",
      "status",
      "list",
      "check",
      "trust",
      "policy-status",
      "policy",
      "show",
      "attest",
      "associate",
      "reauthorize",
      "revoke-callback",
    ].includes(command) ||
    rest.length % 2
  )
    throw Error("InvalidArguments");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (
      ![
        "--url",
        "--auth-file",
        "--request-file",
        "--host",
        "--revision",
        "--expected-generation",
        "--fingerprint",
      ].includes(name) ||
      Object.hasOwn(options, name) ||
      !rest[i + 1]
    )
      throw Error("InvalidArguments");
    options[name] = rest[i + 1];
  }
  const hostCommand = [
    "check",
    "policy-status",
    "policy",
    "show",
    "attest",
    "associate",
    "reauthorize",
    "revoke-callback",
    "lifecycle",
  ].includes(command);
  if (
    !options["--url"] ||
    !options["--auth-file"] ||
    [
      "stage",
      "attest",
      "associate",
      "reauthorize",
      "activate",
      "lifecycle",
    ].includes(command) !== Boolean(options["--request-file"]) ||
    hostCommand !== Boolean(options["--host"]) ||
    ["check", "policy", "revoke-callback"].includes(command) !==
      Boolean(options["--revision"]) ||
    (command === "policy") !==
      Boolean(options["--expected-generation"] && options["--fingerprint"]) ||
    (command !== "policy" &&
      (options["--expected-generation"] || options["--fingerprint"])) ||
    (hostCommand &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options["--host"])) ||
    (options["--revision"] &&
      (!/^[1-9][0-9]*$/.test(options["--revision"]) ||
        !Number.isSafeInteger(Number(options["--revision"])))) ||
    (command === "policy" &&
      (!/^(0|[1-9][0-9]*)$/.test(options["--expected-generation"]) ||
        !Number.isSafeInteger(Number(options["--expected-generation"])) ||
        !/^[a-f0-9]{64}$/.test(options["--fingerprint"])))
  )
    throw Error("InvalidArguments");
  const base = new URL(options["--url"]);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw Error("InvalidArguments");
  return { command, options, base };
}
try {
  const { command, options, base } = argumentsFor(process.argv.slice(2));
  const password = (await protectedFile(options["--auth-file"])).replace(
    /\r?\n$/,
    "",
  );
  if (!password) throw Error("InvalidProtectedInput");
  const body = [
    "stage",
    "attest",
    "associate",
    "reauthorize",
    "activate",
    "lifecycle",
  ].includes(command)
    ? JSON.parse(await protectedFile(options["--request-file"]))
    : command === "check"
      ? { expectedRevision: Number(options["--revision"]) }
      : command === "revoke-callback"
        ? { revision: Number(options["--revision"]) }
        : command === "policy"
          ? {
              revision: Number(options["--revision"]),
              expectedGeneration: Number(options["--expected-generation"]),
              fingerprint: options["--fingerprint"],
            }
          : undefined;
  const path =
    command === "phase"
      ? "/admin/pds-registry/phase"
      : command === "activate"
        ? "/admin/pds-registry/activate"
        : command === "lifecycle"
          ? `/admin/pds-registry/hosts/${encodeURIComponent(options["--host"])}/lifecycle`
          : command === "status"
            ? "/admin/pds-registry/status"
            : command === "trust"
              ? "/admin/pds-registry/trust"
              : command === "revoke-callback"
                ? `/admin/pds-registry/hosts/${encodeURIComponent(options["--host"])}/callback/revoke`
                : ["show", "attest", "associate", "reauthorize"].includes(
                      command,
                    )
                  ? `/admin/pds-registry/hosts/${encodeURIComponent(options["--host"])}${command === "show" ? "" : `/${command}`}`
                  : command === "check"
                    ? `/admin/pds-registry/hosts/${encodeURIComponent(options["--host"])}/check`
                    : command === "policy" || command === "policy-status"
                      ? `/admin/pds-registry/hosts/${encodeURIComponent(options["--host"])}/policy`
                      : "/admin/pds-registry/hosts";
  const response = await fetch(new URL(path, base), {
    method: [
      "stage",
      "activate",
      "lifecycle",
      "check",
      "policy",
      "attest",
      "associate",
      "reauthorize",
      "revoke-callback",
    ].includes(command)
      ? "POST"
      : "GET",
    headers: {
      authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(command === "check" ? 35_000 : 10_000),
  });
  if (!response.ok) {
    console.error(`Registry request failed (${response.status})`);
    process.exitCode = 1;
  } else {
    const result = await response.json();
    if (command === "phase" || command === "activate") {
      if (
        !["bootstrap", "registry-serving"].includes(result.phase) ||
        !Number.isSafeInteger(result.generation)
      )
        throw Error("UnexpectedPhaseResult");
      console.log(
        JSON.stringify({ phase: result.phase, generation: result.generation }),
      );
    } else if (command === "lifecycle") {
      if (
        result.hostId !== options["--host"] ||
        !["disabled", "enabled", "draining", "retired"].includes(
          result.lifecycle,
        ) ||
        !Number.isSafeInteger(result.lifecycleVersion)
      )
        throw Error("UnexpectedLifecycleResult");
      console.log(
        JSON.stringify({
          hostId: result.hostId,
          lifecycle: result.lifecycle,
          lifecycleVersion: result.lifecycleVersion,
          activeRevision: result.activeRevision,
        }),
      );
    } else if (command === "revoke-callback") {
      if (result.revoked !== true) throw Error("UnexpectedRevocationResult");
      console.log(JSON.stringify({ revoked: true }));
    } else if (command === "status")
      console.log(
        JSON.stringify({
          configured: result.configured === true,
          ready: result.ready === true,
          missingCount: Number.isSafeInteger(result.missingCount)
            ? result.missingCount
            : null,
        }),
      );
    else if (command === "trust") {
      const { issuer, serviceDid, jwtPublicKeyHex, plcRotationKeyDid } = result;
      console.log(
        JSON.stringify({
          issuer,
          serviceDid,
          jwtPublicKeyHex,
          plcRotationKeyDid,
        }),
      );
    } else if (command === "policy-status") {
      const project = (value) =>
        value && {
          revision: value.revision,
          generation: value.generation,
          fingerprint: value.fingerprint,
        };
      console.log(
        JSON.stringify({
          current: project(result.current),
          intended: project(result.intended),
        }),
      );
    } else if (command === "policy") {
      const { revision, generation, fingerprint } = result.policy;
      if (
        revision !== Number(options["--revision"]) ||
        fingerprint !== options["--fingerprint"]
      )
        throw Error("UnexpectedPolicyResult");
      console.log(
        JSON.stringify({ policy: { revision, generation, fingerprint } }),
      );
    } else if (command === "check") {
      const last = result.outbound?.last;
      if (!last || last.revision !== Number(options["--revision"]))
        throw Error("UnexpectedCheckRevision");
      console.log(
        JSON.stringify({
          outbound: {
            pending: result.outbound?.pending === true,
            last: last && {
              revision: last.revision,
              direction: last.direction,
              receiptId: last.receiptId,
              generation: last.generation,
              manifestFingerprint: last.manifestFingerprint,
              verifierVersion: last.verifierVersion,
              verifierPolicyFingerprint: last.verifierPolicyFingerprint,
              verifierPolicyGeneration: last.verifierPolicyGeneration,
              observedAt: last.observedAt,
              completedAt: last.completedAt,
              expiresAt: last.expiresAt,
              expired: last.expired === true,
              publicDidOk: last.publicDidOk === true,
              internalDidOk: last.internalDidOk === true,
              publicMetadataOk: last.publicMetadataOk === true,
              internalMetadataOk: last.internalMetadataOk === true,
              adminAttempted: last.adminAttempted === true,
              adminOk: last.adminOk === true,
              reason: last.reason,
            },
          },
          inbound: "unproven",
          association: result.association,
        }),
      );
      if (!last || last.reason !== "ok") process.exitCode = 1;
    } else if (
      ["show", "attest", "associate", "reauthorize"].includes(command)
    ) {
      console.log(JSON.stringify(result));
    } else if (command === "stage") {
      const {
        hostId,
        serviceDid,
        publicUrl,
        internalUrl,
        order,
        revision,
        stagedIncomingMigration,
      } = result.staged;
      console.log(
        JSON.stringify({
          staged: {
            hostId,
            serviceDid,
            publicUrl,
            internalUrl,
            order,
            revision,
            stagedIncomingMigration,
          },
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          hosts: result.hosts.map(
            ({
              hostId,
              revision,
              order,
              association,
              lifecycle,
              activeRevision,
              stagedRevision,
            }) => ({
              hostId,
              revision,
              order,
              association,
              lifecycle,
              activeRevision,
              stagedRevision,
            }),
          ),
        }),
      );
    }
  }
} catch {
  console.error(
    "Registry command failed; check protected inputs and connection",
  );
  process.exitCode = 1;
}
