import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
test("resolved model and existing resources fail closed without exposing config", () => {
  const dir = mkdtempSync(join(tmpdir(), "compose-guard-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const mock = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2); fs.appendFileSync(process.env.LOG, args.join(' ') + '\\n');
const mode = process.env.MODE, project = 'hypercerts-entryway-test';
if (args.includes('config')) {
 if (mode === 'config-error') process.exit(1);
 console.log(JSON.stringify({name:project, secrets:{secret:'PRIVATE-CONTENT'}, services:{app:{container_name:mode === 'container-name' ? 'foreign' : project+'-app-1'}}, volumes:{data:{name: mode === 'off-project' ? 'foreign' : project+'_data', external:mode === 'external'}}, networks:{default:{name:project+'_default', external:mode === 'external-network'}}}));
} else if (args.includes('ls')) {
 if (mode === 'list-error') process.exit(1);
 if (args.includes('volume') && ['foreign-volume','inspect-error','owned'].includes(mode)) console.log(project+'_data');
 if (args.includes('network') && mode === 'foreign-network') console.log(project+'_default');
 if (args.includes('container') && mode === 'stopped') console.log(project+'-app-1');
} else if (args.includes('inspect')) {
 if (mode === 'inspect-error') process.exit(1);
 const labels = mode === 'owned' ? {'com.docker.compose.project':project, 'com.docker.compose.volume':'data'} : {'com.docker.compose.project':'foreign'};
 console.log(JSON.stringify([args.includes('container') ? {Config:{Labels:labels}} : {Labels:labels}]));
} else process.exit(1);
`;
    writeFileSync(join(bin, "docker"), mock, { mode: 0o755 });
    for (const mode of [
      "foreign-volume",
      "foreign-network",
      "stopped",
      "external",
      "external-network",
      "off-project",
      "container-name",
      "config-error",
      "list-error",
      "inspect-error",
      "owned",
    ]) {
      const log = join(dir, mode);
      const result = spawnSync(
        process.execPath,
        [
          join(root, "tests/support/incoming-compose-guard.mjs"),
          "rootless",
          "hypercerts-entryway-test",
          "/checkout",
          root,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            LOG: log,
            MODE: mode,
          },
        },
      );
      assert.equal(result.status === 0, mode === "owned", mode);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-CONTENT/);
      assert.doesNotMatch(
        readFileSync(log, "utf8"),
        /\b(up|down|restart|rm)\b/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
