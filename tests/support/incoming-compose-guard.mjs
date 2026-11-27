import { spawnSync } from "node:child_process";

const [context, project, checkout, root] = process.argv.slice(2);
function docker(...args) {
  const result = spawnSync("docker", ["--context", context, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw Error();
  return result.stdout;
}
try {
  const model = JSON.parse(
    docker(
      "compose",
      "--project-name",
      project,
      "-f",
      `${checkout}/compose.yaml`,
      "-f",
      `${root}/tests/atmosphere/stacks/incoming-source-mail.yaml`,
      "--profile",
      "*",
      "config",
      "--format",
      "json",
    ),
  );
  if (model.name !== project) throw Error();
  const planned = { volume: new Map(), network: new Map() };
  for (const [kind, section] of [
    ["volume", "volumes"],
    ["network", "networks"],
  ]) {
    for (const [key, value] of Object.entries(model[section] ?? {})) {
      if (
        !value ||
        value.external ||
        typeof value.name !== "string" ||
        !value.name.startsWith(`${project}_`) ||
        planned[kind].has(value.name)
      )
        throw Error();
      planned[kind].set(value.name, key);
    }
  }
  for (const service of Object.values(model.services ?? {})) {
    if (
      service.container_name &&
      !service.container_name.startsWith(`${project}-`) &&
      !service.container_name.startsWith(`${project}_`)
    )
      throw Error();
  }
  const projectContainers = docker(
    "container",
    "ls",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    "{{.Names}}",
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (
    projectContainers.some(
      (name) =>
        !name.startsWith(`${project}-`) && !name.startsWith(`${project}_`),
    )
  )
    throw Error();
  for (const kind of ["volume", "network", "container"]) {
    const args = [
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      "--format",
      kind === "container" ? "{{.Names}}" : "{{.Name}}",
    ];
    const names = docker(...args)
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const name of names) {
      const relevant =
        kind === "container"
          ? name.startsWith(`${project}-`) || name.startsWith(`${project}_`)
          : planned[kind].has(name);
      if (!relevant) continue;
      const inspected = JSON.parse(docker(kind, "inspect", name));
      if (!Array.isArray(inspected) || inspected.length !== 1) throw Error();
      const labels =
        kind === "container"
          ? inspected[0].Config?.Labels
          : inspected[0].Labels;
      if (
        labels?.["com.docker.compose.project"] !== project ||
        (kind !== "container" &&
          labels?.[`com.docker.compose.${kind}`] !== planned[kind].get(name))
      )
        throw Error();
    }
  }
} catch {
  console.error("Incoming Compose ownership validation failed");
  process.exit(1);
}
