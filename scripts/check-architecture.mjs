import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import ts from "typescript6";
import { parse } from "svelte/compiler";
import { pathToFileURL } from "node:url";

const normalize = (value) => value.split(sep).join("/");
function referencesIn(source, filename) {
  if (filename.endsWith(".svelte")) {
    const component = parse(source, { modern: true });
    const references = [];
    for (const script of [component.instance, component.module]) {
      if (script)
        references.push(
          ...referencesIn(
            source.slice(script.content.start, script.content.end),
            `${filename}.ts`,
          ),
        );
    }
    const visitTemplate = (node) => {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "ImportExpression" ||
        (node.type === "CallExpression" && node.callee?.name === "require")
      ) {
        references.push(
          ...referencesIn(
            `const expression = ${source.slice(node.start, node.end)}`,
            `${filename}.ts`,
          ),
        );
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visitTemplate);
        else if (value && typeof value === "object") visitTemplate(value);
      }
    };
    visitTemplate(component.fragment);
    return references;
  }
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const references = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      references.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: Boolean(node.isTypeOnly || node.importClause?.isTypeOnly),
      });
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      references.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return references;
}
export function importsIn(source, filename) {
  return referencesIn(source, filename).map(({ specifier }) => specifier);
}

function matchingPath(specifier, paths) {
  if (Object.hasOwn(paths, specifier)) return [specifier, ""];
  let best;
  for (const pattern of Object.keys(paths)) {
    const wildcard = pattern.indexOf("*");
    if (wildcard < 0 || pattern.indexOf("*", wildcard + 1) >= 0) continue;
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (!best || prefix.length > best.prefixLength)
    )
      best = {
        pattern,
        prefixLength: prefix.length,
        capture: specifier.slice(
          prefix.length,
          specifier.length - suffix.length,
        ),
      };
  }
  return best && [best.pattern, best.capture];
}

function resolveReference(specifier, filename, appRoot, options) {
  if (specifier.startsWith("#entryway-ssr/")) {
    const owner = specifier.slice("#entryway-ssr/".length);
    const candidate = resolve(
      appRoot,
      owner === "ui" ? "src/ui/ssr.ts" : `src/features/${owner}/ssr.ts`,
    );
    return existsSync(candidate) ? candidate : undefined;
  }
  const virtualComponent = (path) => {
    if (path.endsWith(".d.svelte.ts"))
      return `${path.slice(0, -".d.svelte.ts".length)}.svelte`;
    if (path.endsWith(".svelte.d.ts")) return path.slice(0, -".d.ts".length);
    return undefined;
  };
  const host = {
    ...ts.sys,
    getCurrentDirectory: () => appRoot,
    fileExists(path) {
      if (ts.sys.fileExists(path)) return true;
      const component = virtualComponent(path);
      return Boolean(component && ts.sys.fileExists(component));
    },
  };
  const resolved = ts.resolveModuleName(
    specifier,
    filename,
    { ...options, paths: options.paths && { ...options.paths } },
    host,
  ).resolvedModule?.resolvedFileName;
  if (!resolved) return undefined;
  const component = virtualComponent(resolved);
  const target =
    component &&
    !specifier.endsWith(".d.svelte.ts") &&
    !specifier.endsWith(".svelte.d.ts") &&
    ts.sys.fileExists(component)
      ? component
      : resolved;
  return ts.sys.fileExists(target) ? realpathSync(target) : target;
}

export function moduleViolations(source, filename, appRoot, options) {
  const owner = normalize(relative(resolve(appRoot, "src"), filename));
  const violations = [];
  const allowedBoundary = /^(?:authentication|mail|database)\//.test(owner);
  if (
    !allowedBoundary &&
    /(?:^|\/)(?:[^/]*\.)?port\.[cm]?[jt]s$|(?:^|\/)(?:ports|adapters)\//.test(
      owner,
    )
  )
    violations.push("port/adapter module outside the three boundaries");
  if (
    !allowedBoundary &&
    /\binterface\s+\w*(?:Port|Transactor|Reader|Transport|Signer)\b/.test(
      source,
    )
  )
    violations.push(
      "interchangeable integration contract outside the three boundaries",
    );
  const pure =
    /(?:^|\/)(?:state-machine|validation|rules|custody)\.[cm]?[jt]s$/.test(
      owner,
    );
  for (const { specifier, typeOnly } of referencesIn(source, filename)) {
    if (
      /^(?:better-auth\/adapters\/drizzle|@better-auth\/drizzle-adapter)(?:\/|$)/.test(
        specifier,
      ) &&
      !owner.startsWith("database/")
    )
      violations.push(
        `${specifier}: authentication database adapter belongs to database`,
      );
    if (
      /^better-auth(?:\/|$)/.test(specifier) &&
      !owner.startsWith("authentication/") &&
      owner !== "database/drizzle/account-authority.mjs" &&
      owner !== "database/connection.ts"
    )
      violations.push(
        `${specifier}: Better Auth belongs to authentication or the pinned authority database helper`,
      );
    if (
      /^(?:better-sqlite3|node:sqlite|sqlite3|kysely|drizzle-orm|pg|pg-pool)(?:\/|$)/.test(
        specifier,
      ) &&
      !owner.startsWith("database/")
    )
      violations.push(`${specifier}: SQL belongs to database`);
    if (
      /^(?:nodemailer|smtp-server)(?:\/|$)/.test(specifier) &&
      !owner.startsWith("mail/")
    )
      violations.push(`${specifier}: SMTP belongs to mail`);
    if (
      pure &&
      /^(?:express|better-auth|better-sqlite3|sqlite3|kysely|drizzle-orm|pg|pg-pool|node:sqlite|node:https?|https?|@atproto\/xrpc-server)(?:\/|$)/.test(
        specifier,
      )
    )
      violations.push(`${specifier}: pure rules cannot depend on HTTP or SQL`);
    const resolved = resolveReference(specifier, filename, appRoot, options);
    if (!resolved) {
      if (
        specifier.startsWith(".") ||
        specifier.startsWith("#entryway-ssr/") ||
        (!ts.isExternalModuleNameRelative(specifier) &&
          matchingPath(specifier, options.paths ?? {}))
      )
        violations.push(`${specifier}: unresolved local import`);
      continue;
    }
    // Classify the resolved provider as well: paths aliases and dynamic imports
    // must not bypass package ownership by hiding the original package name.
    const resolvedPackages = [
      ...normalize(resolved).matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g),
    ];
    const packageName = resolvedPackages.at(-1)?.[1];
    if (
      (packageName === "@better-auth/drizzle-adapter" ||
        (packageName === "better-auth" &&
          /\/adapters\/drizzle(?:-adapter)?\//.test(normalize(resolved)))) &&
      !owner.startsWith("database/")
    )
      violations.push(
        `${specifier}: resolved authentication database adapter belongs to database`,
      );
    if (
      packageName === "better-auth" &&
      !owner.startsWith("authentication/") &&
      owner !== "database/drizzle/account-authority.mjs" &&
      owner !== "database/connection.ts"
    )
      violations.push(
        `${specifier}: resolved Better Auth belongs to authentication`,
      );
    if (
      [
        "better-sqlite3",
        "sqlite3",
        "kysely",
        "drizzle-orm",
        "pg",
        "pg-pool",
      ].includes(packageName) &&
      !owner.startsWith("database/")
    )
      violations.push(`${specifier}: resolved SQL belongs to database`);
    if (
      ["nodemailer", "smtp-server"].includes(packageName) &&
      !owner.startsWith("mail/")
    )
      violations.push(`${specifier}: resolved SMTP belongs to mail`);
    if (
      pure &&
      [
        "better-auth",
        "better-sqlite3",
        "sqlite3",
        "kysely",
        "drizzle-orm",
        "pg",
        "pg-pool",
        "express",
        "@atproto/xrpc-server",
      ].includes(packageName)
    )
      violations.push(
        `${specifier}: pure rules cannot depend on resolved HTTP, authentication or SQL`,
      );
    const target = normalize(
      relative(resolve(appRoot, "src"), resolve(resolved)),
    );
    const ownFeature = /^features\/([^/]+)\//.exec(owner)?.[1];
    const targetFeature = /^features\/([^/]+)\//.exec(target)?.[1];
    if (ownFeature && targetFeature && ownFeature !== targetFeature)
      violations.push(
        `${specifier}: feature ${ownFeature} imports ${targetFeature} internals`,
      );
    if (pure && /^(?:database|http|pds|authentication)\//.test(target))
      violations.push(`${specifier}: pure rules depend on ${target}`);
    if (target.startsWith("../tests/")) {
      const syntheticConcreteType =
        owner === "features/external-migration/import-account.ts" &&
        typeOnly &&
        /^\.\.\/tests\/fixtures\/(?:source-client|source-handoff)\.ts$/.test(
          target,
        );
      const syntheticComposition =
        owner === "app.mjs" &&
        target === "../tests/fixtures/synthetic-client.mjs";
      if (!syntheticConcreteType && !syntheticComposition)
        violations.push(
          `${specifier}: test helper outside explicitly synthetic composition`,
        );
    }
  }
  if (
    /\.sqlite\s*\.\s*(?:prepare|exec|transaction)\s*\(/.test(source) &&
    !owner.startsWith("database/")
  )
    violations.push("raw application SQL/transactions must stay in database");
  return violations;
}

export function checkArchitecture(appRoot) {
  const configPath = ts.findConfigFile(
    appRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) throw Error("Missing TypeScript configuration");
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw Error("Invalid TypeScript configuration");
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, appRoot);
  if (parsed.errors.length) throw Error("Invalid TypeScript configuration");
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        /\.(?:ts|mjs|svelte)$/.test(entry.name) &&
        !entry.name.endsWith(".test.mjs")
      )
        files.push(path);
    }
  };
  walk(resolve(appRoot, "src"));
  const violations = [];
  const graph = new Map();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    violations.push(
      ...moduleViolations(source, file, appRoot, parsed.options).map(
        (issue) => `${normalize(relative(appRoot, file))}: ${issue}`,
      ),
    );
    graph.set(
      file,
      referencesIn(source, file)
        .filter((ref) => !ref.typeOnly)
        .map(({ specifier }) =>
          resolveReference(specifier, file, appRoot, parsed.options),
        )
        .filter((target) => target && files.includes(resolve(target)))
        .map((target) => resolve(target)),
    );
  }
  const done = new Set(),
    visiting = new Set();
  const visit = (file, chain) => {
    if (visiting.has(file)) {
      violations.push(
        `import cycle: ${[...chain, file].map((p) => normalize(relative(appRoot, p))).join(" -> ")}`,
      );
      return;
    }
    if (done.has(file)) return;
    visiting.add(file);
    for (const target of graph.get(file) ?? []) visit(target, [...chain, file]);
    visiting.delete(file);
    done.add(file);
  };
  for (const file of files) visit(file, []);
  return { files: files.length, violations };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = checkArchitecture(resolve("."));
  for (const violation of result.violations) console.error(violation);
  console.log(
    `Checked ${result.files} application source files; ${result.violations.length} boundary violations`,
  );
  process.exitCode = result.violations.length ? 1 : 0;
}
