import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript6";
import {
  checkArchitecture,
  moduleViolations,
  importsIn,
} from "../../scripts/check-architecture.mjs";
import { discoverContracts } from "../support/discover-contracts.mjs";

function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "entryway-architecture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, source) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    return path;
  };
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    paths: {
      "@storage/*": [join(root, "src/database/*")],
      "@features/*": [join(root, "src/features/*")],
    },
  };
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        allowJs: true,
      },
      include: ["src/**/*"],
    }),
  );
  for (const [name, source] of Object.entries(files)) write(name, source);
  return {
    root,
    write,
    options,
    check(name, source) {
      return moduleViolations(source, write(name, source), root, options);
    },
  };
}

test("application respects the three boundaries and contains no runtime import cycles", () => {
  const result = checkArchitecture(resolve("."));
  assert.ok(result.files > 0);
  assert.deepEqual(result.violations, []);
});

test("custody-writing workflows receive storage from composition rather than constructing adapters", () => {
  for (const file of [
    "src/features/account-registration/create-account.ts",
    "src/features/handle-change/change-handle.ts",
    "src/plc/operations.ts",
    "src/features/pds-migration/move-between-pds.mjs",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /createCustodyInventoryStorage|database\/drizzle\/migration-custody/,
      file,
    );
    assert.match(source, /custody\.recordSigned/, file);
  }
});

test("authentication, database and mail accept their own provider integrations", (t) => {
  const f = fixture(t);
  for (const [name, source] of [
    [
      "src/authentication/better-auth.mjs",
      "import { betterAuth } from 'better-auth'",
    ],
    [
      "src/database/connection.ts",
      "import Database from 'better-sqlite3'; db.sqlite.prepare('SELECT 1')",
    ],
    [
      "src/database/drizzle/account-authority.mjs",
      "import { hashPassword } from 'better-auth/crypto'",
    ],
    [
      "src/database/connection.ts",
      "import { drizzleAdapter } from 'better-auth/adapters/drizzle'; import pg from 'pg'; import { drizzle } from 'drizzle-orm/node-postgres'",
    ],
    ["src/mail/smtp.ts", "import nodemailer from 'nodemailer'"],
    ["src/authentication/port.ts", "export interface BrowserPort {}"],
    ["src/database/account.port.ts", "export interface AccountTransactor {}"],
    ["src/mail/port.ts", "export interface MailTransport {}"],
  ])
    assert.deepEqual(f.check(name, source), [], name);
});

test("features cannot directly use authentication, SMTP or SQL providers", (t) => {
  const f = fixture(t);
  const violations = f.check(
    "src/features/email-login/routes.mjs",
    "import { betterAuth } from 'better-auth'; const smtp = require('nodemailer'); const sql = await import('node:sqlite')",
  );
  for (const message of [
    "Better Auth belongs",
    "SMTP belongs",
    "SQL belongs",
  ]) {
    assert.ok(
      violations.some((issue) => issue.includes(message)),
      message,
    );
  }
  assert.ok(
    f
      .check(
        "src/features/email-login/operation.ts",
        "db.sqlite.transaction(() => {})()",
      )
      .some((issue) => issue.includes("raw application SQL")),
  );
});

test("ports and interchangeable integration contracts stay at the three boundaries", (t) => {
  const f = fixture(t);
  for (const name of [
    "src/pds/client.port.ts",
    "src/plc/ports/signing.ts",
    "src/pds/adapters/client.mjs",
  ]) {
    assert.ok(
      f
        .check(name, "export const value = 1")
        .some((issue) => issue.includes("outside the three boundaries")),
      name,
    );
  }
  for (const name of [
    "SourcePort",
    "SourceSigner",
    "SnapshotReader",
    "SourceTransactor",
    "SourceTransport",
  ]) {
    assert.ok(
      f
        .check("src/pds/client.ts", `export interface ${name} {}`)
        .some((issue) =>
          issue.includes("interchangeable integration contract"),
        ),
      name,
    );
  }
  assert.deepEqual(
    f.check("src/plc/signing.ts", "export class ConcreteSigner {}"),
    [],
  );
});

test("pure rules resolve aliased storage imports and reject HTTP dependencies", (t) => {
  const f = fixture(t, { "src/database/sqlite/sql.ts": "export const x = 1" });
  const violations = f.check(
    "src/features/account-registration/rules.ts",
    "import { x } from '@storage/sqlite/sql.js'; import express from 'express'",
  );
  // Preserve the original alias-resolution regression with the new logical boundary.
  assert.ok(
    violations.some((issue) => issue.includes("database/sqlite/sql.ts")),
  );
  assert.ok(
    violations.some((issue) =>
      issue.includes("express: pure rules cannot depend on HTTP or SQL"),
    ),
  );
});

test("TS imports and reexports cannot reach another feature through aliases", (t) => {
  const f = fixture(t, {
    "src/features/account-settings/internal.ts": "export const value = 1",
  });
  for (const statement of [
    "import { value } from '@features/account-settings/internal.js'",
    "export { value } from '@features/account-settings/internal.js'",
  ]) {
    assert.ok(
      f
        .check("src/features/email-login/operation.ts", statement)
        .some((issue) =>
          issue.includes(
            "feature email-login imports account-settings internals",
          ),
        ),
    );
  }
});

test("MJS dynamic import and require cannot hide cross-feature dependencies", (t) => {
  const f = fixture(t, {
    "src/features/account-settings/internal.mjs": "export const value = 1",
  });
  for (const statement of [
    "await import('@features/account-settings/internal.mjs')",
    "require('@features/account-settings/internal.mjs')",
  ]) {
    assert.ok(
      f
        .check("src/features/email-login/routes.mjs", statement)
        .some((issue) =>
          issue.includes(
            "feature email-login imports account-settings internals",
          ),
        ),
    );
  }
});

test("import parsing records static, type-only, reexport, dynamic and require references", () => {
  assert.deepEqual(
    importsIn(
      "import type { A } from './a.js'; export { b } from './b.js'; import './c.mjs'; await import('./d.mjs'); require('./e.mjs')",
      "example.ts",
    ),
    ["./a.js", "./b.js", "./c.mjs", "./d.mjs", "./e.mjs"],
  );
});

test("same-feature modules and shared value modules remain usable", (t) => {
  const f = fixture(t, {
    "src/features/email-login/page.mjs": "export const page = 1",
    "src/accounts/types.ts": "export interface Account { did: string }",
  });
  assert.deepEqual(
    f.check(
      "src/features/email-login/routes.mjs",
      "import { page } from './page.mjs'",
    ),
    [],
  );
  assert.deepEqual(
    f.check(
      "src/features/email-login/rules.ts",
      "import type { Account } from '../../accounts/types.js'",
    ),
    [],
  );
});

test("unresolved relative and aliased local imports fail explicitly", (t) => {
  const f = fixture(t);
  for (const reference of ["./missing.mjs", "@storage/missing.js"]) {
    assert.ok(
      f
        .check("src/features/email-login/routes.mjs", `import '${reference}'`)
        .some((issue) => issue === `${reference}: unresolved local import`),
    );
  }
});

test("runtime cycles are detected across TS and MJS while type-only links are excluded", (t) => {
  const f = fixture(t, {
    "src/accounts/a.ts": "import './b.mjs'; export const a = 1",
    "src/accounts/b.mjs": "await import('./a.js')",
  });
  assert.ok(
    checkArchitecture(f.root).violations.some((issue) =>
      issue.startsWith("import cycle:"),
    ),
  );
  f.write(
    "src/accounts/a.ts",
    "import type { B } from './b.mjs'; export interface A {}",
  );
  f.write("src/accounts/b.mjs", "import './a.js'; export class B {}");
  assert.deepEqual(checkArchitecture(f.root).violations, []);
});

test("only the two explicit synthetic source classes may be type-referenced by migration", (t) => {
  const f = fixture(t, {
    "tests/fixtures/source-client.ts": "export class SourceFixtureClient {}",
    "tests/fixtures/source-handoff.ts":
      "export class BoundFixtureSourceHandoffSigner {}",
    "tests/fixtures/other.ts": "export class Other {}",
  });
  const owner = "src/features/external-migration/import-account.ts";
  for (const name of ["source-client", "source-handoff"]) {
    assert.deepEqual(
      f.check(
        owner,
        `import type * as Fixture from '../../../tests/fixtures/${name}.js'`,
      ),
      [],
    );
    assert.ok(
      f
        .check(
          owner,
          `import * as Fixture from '../../../tests/fixtures/${name}.js'`,
        )
        .some((issue) => issue.includes("test helper outside")),
    );
  }
  assert.ok(
    f
      .check(
        owner,
        "import type * as Fixture from '../../../tests/fixtures/other.js'",
      )
      .some((issue) => issue.includes("test helper outside")),
  );
  assert.ok(
    f
      .check(
        "src/features/email-login/routes.ts",
        "import type * as Fixture from '../../../tests/fixtures/source-client.js'",
      )
      .some((issue) => issue.includes("test helper outside")),
  );
});

test("synthetic browser composition exception is limited to the app entry", (t) => {
  const f = fixture(t, {
    "tests/fixtures/synthetic-client.mjs": "export const client = 1",
  });
  assert.deepEqual(
    f.check("src/app.mjs", "import '../tests/fixtures/synthetic-client.mjs'"),
    [],
  );
  assert.ok(
    f
      .check(
        "src/features/email-login/routes.mjs",
        "import '../../../tests/fixtures/synthetic-client.mjs'",
      )
      .some((issue) => issue.includes("test helper outside")),
  );
});

test("contract discovery includes nested feature tests once, sorted, in full and unit runs", (t) => {
  const f = fixture(t, {
    "src/features/handle-change/change-handle.test.mjs": "",
    "src/features/email-login/nested/login.test.mjs": "",
    "src/features/email-login/helper.mjs": "",
    "tests/contracts/service-auth.test.mjs": "",
    "tests/contracts/contracts.test.mjs": "",
    "tests/contracts/nested/not-a-contract.test.mjs": "",
  });
  assert.deepEqual(discoverContracts(f.root), [
    "src/features/email-login/nested/login.test.mjs",
    "src/features/handle-change/change-handle.test.mjs",
    "tests/contracts/contracts.test.mjs",
    "tests/contracts/service-auth.test.mjs",
  ]);
  assert.deepEqual(discoverContracts(f.root, { unit: true }), [
    "src/features/email-login/nested/login.test.mjs",
    "src/features/handle-change/change-handle.test.mjs",
    "tests/contracts/service-auth.test.mjs",
  ]);
});

// Aliases must not disguise provider package ownership after resolution.
test("resolved provider aliases cannot bypass authentication, SQL or SMTP ownership", (t) => {
  const f = fixture(t);
  const providers = [
    ["@auth-provider", "better-auth", "resolved Better Auth"],
    ["@sql-provider", "better-sqlite3", "resolved SQL"],
    ["@drizzle-provider", "drizzle-orm", "resolved SQL"],
    ["@postgres-provider", "pg", "resolved SQL"],
    ["@mail-provider", "nodemailer", "resolved SMTP"],
  ];
  for (const [alias, provider] of providers) {
    const path = f.write(
      `node_modules/${provider}/index.ts`,
      "export const value = 1",
    );
    f.options.paths[alias] = [path];
  }
  for (const [alias, _provider, message] of providers) {
    for (const statement of [
      `import { value } from '${alias}'`,
      `await import('${alias}')`,
      `require('${alias}')`,
    ]) {
      assert.ok(
        f
          .check("src/features/email-login/routes.mjs", statement)
          .some((issue) => issue.includes(message)),
        `${alias}: ${statement}`,
      );
    }
  }
  for (const dependency of ["node:sqlite", "sqlite3", "kysely"]) {
    assert.ok(
      f
        .check("src/accounts/rules.ts", `import '${dependency}'`)
        .some((issue) => issue.includes("pure rules cannot depend")),
      dependency,
    );
  }
});

test("Drizzle and PostgreSQL providers stay inside database for all import forms", (t) => {
  const f = fixture(t);
  for (const provider of [
    "drizzle-orm",
    "drizzle-orm/sqlite-core",
    "drizzle-orm/node-postgres",
    "pg",
    "pg-pool",
  ]) {
    for (const source of [
      `import value from '${provider}'`,
      `await import('${provider}')`,
      `require('${provider}')`,
    ]) {
      assert.ok(
        f
          .check("src/features/email-login/routes.mjs", source)
          .some((issue) => issue.includes("SQL belongs to database")),
        source,
      );
      assert.ok(
        f
          .check("src/accounts/rules.ts", source)
          .some((issue) => issue.includes("pure rules")),
        source,
      );
    }
  }
  assert.ok(
    f
      .check(
        "src/authentication/better-auth.mjs",
        "import { drizzleAdapter } from 'better-auth/adapters/drizzle'",
      )
      .some((issue) => issue.includes("database adapter belongs to database")),
  );
  assert.ok(
    f
      .check(
        "src/authentication/better-auth.mjs",
        "import { drizzleAdapter } from '@better-auth/drizzle-adapter'",
      )
      .some((issue) => issue.includes("database adapter belongs to database")),
  );
});

test("resolved Better Auth database adapter aliases cannot bypass database ownership", (t) => {
  const f = fixture(t);
  const adapterAliases = [
    [
      "@provider-db",
      "node_modules/better-auth/dist/adapters/drizzle-adapter/index.d.mts",
    ],
    [
      "@provider-db-package",
      "node_modules/@better-auth/drizzle-adapter/dist/index.d.mts",
    ],
  ];
  for (const [alias, path] of adapterAliases) {
    f.options.paths[alias] = [
      f.write(path, "export declare const drizzleAdapter: unknown"),
    ];
  }
  for (const [alias] of adapterAliases) {
    for (const statement of [
      `import { drizzleAdapter } from '${alias}'`,
      `await import('${alias}')`,
      `require('${alias}')`,
    ]) {
      assert.ok(
        f
          .check("src/authentication/better-auth.mjs", statement)
          .some((issue) =>
            issue.includes(
              "resolved authentication database adapter belongs to database",
            ),
          ),
        `${statement}: ${JSON.stringify(f.check("src/authentication/better-auth.mjs", statement))}`,
      );
      assert.deepEqual(f.check("src/database/connection.ts", statement), []);
    }
  }
});
