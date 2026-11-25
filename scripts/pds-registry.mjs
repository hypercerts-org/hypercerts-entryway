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
  if (!["stage", "status", "list"].includes(command) || rest.length % 2)
    throw Error("InvalidArguments");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (
      !["--url", "--auth-file", "--request-file"].includes(name) ||
      Object.hasOwn(options, name) ||
      !rest[i + 1]
    )
      throw Error("InvalidArguments");
    options[name] = rest[i + 1];
  }
  if (
    !options["--url"] ||
    !options["--auth-file"] ||
    (command === "stage") !== Boolean(options["--request-file"])
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
  const body =
    command === "stage"
      ? JSON.parse(await protectedFile(options["--request-file"]))
      : undefined;
  const path =
    command === "status"
      ? "/admin/pds-registry/status"
      : "/admin/pds-registry/hosts";
  const response = await fetch(new URL(path, base), {
    method: command === "stage" ? "POST" : "GET",
    headers: {
      authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    console.error(`Registry request failed (${response.status})`);
    process.exitCode = 1;
  } else {
    const result = await response.json();
    if (command === "status")
      console.log(
        JSON.stringify({
          configured: result.configured === true,
          ready: result.ready === true,
          missingCount: Number.isSafeInteger(result.missingCount)
            ? result.missingCount
            : null,
        }),
      );
    else if (command === "stage") {
      const { hostId, serviceDid, publicUrl, internalUrl, order, revision } =
        result.staged;
      console.log(
        JSON.stringify({
          staged: {
            hostId,
            serviceDid,
            publicUrl,
            internalUrl,
            order,
            revision,
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
