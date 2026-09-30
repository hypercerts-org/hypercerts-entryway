#!/usr/bin/env bash
# Only this project's sandbox is controlled; application execution stays in containers.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
sandbox=${ENTRYWAY_SANDBOX_ROOT:-"$root/tests/.runtime/atmosphereinabox"}
project=${ENTRYWAY_E2E_PROJECT:-hypercerts-entryway}
artifacts=${ENTRYWAY_E2E_REPORT_DIR:-"$root/tests/artifacts"}
export ENTRYWAY_SANDBOX_ROOT="$sandbox" ENTRYWAY_E2E_PROJECT="$project" ENTRYWAY_E2E_REPORT_DIR="$artifacts"
[[ "$project" =~ ^hypercerts-entryway(-[a-z0-9_-]+)?$ ]] || { echo "Invalid Entryway project name" >&2; exit 2; }
mkdir -p "$sandbox"
cd "$sandbox"
command=${1:-help}
mkdir -p "$artifacts"
compose() { docker compose --project-name "$project" -f "$sandbox/compose.yaml" "$@"; }
guard_project() {
  node --input-type=module - "$sandbox/state/manifest.json" "$project" <<'JS'
import { readFileSync } from 'node:fs'
const [path, expected] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(path, 'utf8'))
if (manifest.project !== expected) throw new Error('Sandbox project differs from selected Entryway project; refusing lifecycle operation')
JS
}
require_state() {
  test -f state/manifest.json && test -f compose.yaml || { echo 'Run ./tests/local.sh prepare first' >&2; exit 2; }
  guard_project
}
browser() { compose run --rm --no-deps browser npx --no-install playwright test --config tests/playwright.config.mjs "$@"; }
external_browser() { compose run --rm --no-deps -e "EXTERNAL_PHASE=$1" browser npx --no-install playwright test --config tests/external.playwright.config.mjs; }
migration_command() { compose exec -T entryway node tests/support/external-migration.mjs "$@"; }
case "$command" in
  fresh)
    temp=$(mktemp -d "${TMPDIR:-/tmp}/hypercerts-entryway-e2e.XXXXXX")
    export ENTRYWAY_SANDBOX_ROOT="$temp/atmosphereinabox"
    export ENTRYWAY_E2E_PROJECT="hypercerts-entryway-$(date +%s)-$$"
    export ENTRYWAY_E2E_REPORT_DIR="$root/tests/artifacts/$ENTRYWAY_E2E_PROJECT"
    cleanup() {
      result=$?
      if (( result != 0 )) && [[ "${ENTRYWAY_E2E_KEEP_FAILED_STATE:-0}" == 1 ]]; then
        echo "Preserved project $ENTRYWAY_E2E_PROJECT at $temp" >&2
      else
        if test -f "$ENTRYWAY_SANDBOX_ROOT/compose.yaml"; then
          if ! docker compose --project-name "$ENTRYWAY_E2E_PROJECT" -f "$ENTRYWAY_SANDBOX_ROOT/compose.yaml" down --volumes --remove-orphans; then
            echo "Scoped cleanup failed; preserved $temp for project $ENTRYWAY_E2E_PROJECT" >&2
            (( result != 0 )) || result=1
            echo "Run exit: $result; reports: $ENTRYWAY_E2E_REPORT_DIR"
            exit "$result"
          fi
        fi
        rm -rf -- "$temp"
      fi
      echo "Run exit: $result; reports: $ENTRYWAY_E2E_REPORT_DIR"
      exit "$result"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    "$root/tests/local.sh" all
    ;;
  prepare)
    if test -f state/manifest.json; then guard_project; fi
    "$root/tests/atmosphere/prepare.sh"
    cd "$sandbox"
    deno task install
    if test -f state/manifest.json; then
      deno task sandbox status
      deno task sandbox check
    else
      deno task sandbox create --manifest "$root/tests/sandbox.json" --project "$project" --subnet auto
      deno task sandbox check
    fi
    ;;
  up)
    require_state
    deno task sandbox up --build
    compose build test browser
    deno task sandbox access --json > "$sandbox/access.json"
    node "$root/tests/atmosphere/validate-access.mjs" "$sandbox/access.json" "$project"
    ;;
  contracts)
    require_state
    compose run --rm --no-deps test node tests/support/run-contracts.mjs
    ;;
  browser)
    require_state
    browser
    ;;
  migration)
    require_state
    exec 9> "$artifacts/migration.lock"
    flock -n 9 || { echo 'Another migration flow is running' >&2; exit 2; }
    migration_command prepare
    compose exec -T entryway node -e "const r=require('/app/artifacts/external-migration.json');if(r.phase!=='prepared'){console.error('This fixture is not fresh; use reverify for completed state or migration-resume for a reviewed interruption.');process.exit(2)}"
    external_browser prepare
    migration_command run --stop-at=authority-handed-off
    compose restart entryway
    compose up -d --wait entryway
    migration_command run --stop-at=repo-imported
    compose restart entryway
    compose up -d --wait entryway
    migration_command run
    migration_command verify
    external_browser complete
    ;;
  migration-resume)
    require_state
    exec 9> "$artifacts/migration.lock"
    flock -n 9 || exit 2
    external_browser prepare
    migration_command run
    migration_command verify
    external_browser complete
    ;;
  resilience)
    require_state
    exec 9> "$artifacts/migration.lock"
    flock -n 9 || { echo 'A migration flow is active; resilience must run alone' >&2; exit 2; }
    node "$root/tests/support/resilience.mjs" --run
    ;;
  reverify)
    require_state
    migration_command verify
    external_browser complete
    ;;
  all)
    "$root/tests/local.sh" prepare
    "$root/tests/local.sh" up
    "$root/tests/local.sh" browser
    "$root/tests/local.sh" contracts
    "$root/tests/local.sh" migration
    "$root/tests/local.sh" resilience
    ;;
  down)
    require_state
    deno task sandbox down
    ;;
  status)
    require_state
    deno task sandbox status
    ;;
  *)
    echo 'Usage: ./tests/local.sh fresh|prepare|up|browser|contracts|migration|migration-resume|reverify|resilience|all|status|down'
    echo 'all requires a fresh project fixture; down retains state and volumes. No implicit reset.'
    ;;
esac
