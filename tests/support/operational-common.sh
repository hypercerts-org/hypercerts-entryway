#!/usr/bin/env bash
# Sourced only by target-owned host lifecycle controllers.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
sandbox=${ENTRYWAY_SANDBOX_ROOT:-"$root/tests/.runtime/atmosphereinabox"}
project=${ENTRYWAY_E2E_PROJECT:-hypercerts-entryway}
artifacts=${ENTRYWAY_E2E_REPORT_DIR:-"$root/tests/artifacts"}
[[ "$project" =~ ^hypercerts-entryway(-[a-z0-9_-]+)?$ ]] || exit 2
node --input-type=module - "$sandbox/state/manifest.json" "$project" <<'JS'
import { readFileSync } from 'node:fs'
const [path, expected] = process.argv.slice(2)
if (JSON.parse(readFileSync(path)).project !== expected) throw Error('Refusing an unowned sandbox project')
JS
mkdir -p "$artifacts"
cd "$sandbox"
exec 9> "$artifacts/migration.lock"
flock -n 9 || { echo 'Another migration or operational flow owns this project' >&2; exit 2; }
compose() { timeout --foreground 240 docker compose --project-name "$project" -f "$sandbox/compose.yaml" "$@"; }
# Assert labels before targeting disposable replacement containers by name.
remove_owned() {
  local label
  label=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$1" 2>/dev/null) || return 0
  [[ "$label" == "$project" ]] || { echo 'Refusing foreign replacement container' >&2; return 1; }
  timeout --foreground 30 docker rm -f "$1" >/dev/null
}
# Summaries only. Configuration, tokens, keys and SQLite remain in private volumes.
record_candidate() {
  compose exec -T entryway node --input-type=module - "$1" <<'JS'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const hash = createHash('sha256')
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) hash.update(file).update(readFileSync(file))
for (const base of ['src', 'dist/src', 'tests/support', 'tests/browser']) {
  for (const name of readdirSync(base, { recursive: true }).sort()) {
    if (!/\.(mjs|ts|sh|json)$/.test(name)) continue
    hash.update(`${base}/${name}\0`).update(readFileSync(`${base}/${name}`))
  }
}
writeFileSync(`/app/artifacts/${process.argv[2]}-candidate.json`, JSON.stringify({ sourceDigest: hash.digest('hex'), pdsVersion: JSON.parse(readFileSync('node_modules/@atproto/pds/package.json')).version }))
JS
  compose images --format json > "$artifacts/$1-images.json"
}
