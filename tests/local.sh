#!/usr/bin/env bash
# Only this project's sandbox is controlled; application execution stays in containers.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
sandbox=${SANDBOX_CHECKOUT:-"$root/tests/.runtime/atmosphereinabox"}
project=${SANDBOX_PROJECT:-hypercerts-entryway}
artifacts=${ACCEPTANCE_REPORT_DIR:-"$root/tests/artifacts"}
export SANDBOX_CHECKOUT="$sandbox" SANDBOX_PROJECT="$project" ACCEPTANCE_REPORT_DIR="$artifacts"
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
    temp=$(mktemp -d "$root/tests/.runtime/hypercerts-entryway-e2e.XXXXXX")
    export SANDBOX_CHECKOUT="$temp/atmosphereinabox"
    export SANDBOX_PROJECT="hypercerts-entryway-$(date +%s)-$$"
    export ACCEPTANCE_REPORT_DIR="$root/tests/artifacts/$SANDBOX_PROJECT"
    cleanup() {
      result=$?
      if (( result != 0 )) && [[ "${KEEP_FAILED_SANDBOX:-0}" == 1 ]]; then
        echo "Preserved project $SANDBOX_PROJECT at $temp" >&2
      else
        if test -f "$SANDBOX_CHECKOUT/compose.yaml"; then
          if ! docker compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" down --volumes --remove-orphans; then
            echo "Scoped cleanup failed; preserved $temp for project $SANDBOX_PROJECT" >&2
            (( result != 0 )) || result=1
            echo "Run exit: $result; reports: $ACCEPTANCE_REPORT_DIR"
            exit "$result"
          fi
        fi
        rm -rf -- "$temp"
      fi
      echo "Run exit: $result; reports: $ACCEPTANCE_REPORT_DIR"
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
    if [[ "${DATABASE_BACKEND:-sqlite}" == postgresql ]]; then
      compose up -d --wait entryway-postgres
    fi
    deno task sandbox up --build
    compose build test browser
    deno task sandbox access --json > "$sandbox/access.json"
    node "$root/tests/atmosphere/validate-access.mjs" "$sandbox/access.json" "$project"
    ;;
  contracts)
    require_state
    compose run --rm --no-deps test node tests/support/run-contracts.mjs
    ;;
  database-contracts)
    require_state
    compose up -d --wait entryway-postgres
    for backend in sqlite postgresql; do
      result=0
      compose run --rm --no-deps -e "CONTRACT_DATABASE_BACKEND=$backend" -e CONTRACT_DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority test node tests/support/run-database-contracts.mjs > "$artifacts/database-$backend.log" 2>&1 || result=$?
      printf '%s\n' "$result" > "$artifacts/database-$backend.exit"
      cat "$artifacts/database-$backend.log"
      (( result == 0 )) || exit "$result"
    done
    bash "$root/tests/support/run-postgresql-profile.sh"
    ;;
  database-profile)
    bash "$root/tests/support/run-postgresql-profile.sh"
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
  interop-profile)
    require_state
    # This child owns the shared lock; all never holds a parent lock here.
    source "$root/tests/support/operational-common.sh"
    record_candidate interop-profile
    compose exec -T entryway node tests/support/interop-profile-probe.mjs > "$artifacts/interop-profile.json"
    ;;
  plc-recovery|process-crash|authority-drills)
    require_state
    bash "$root/tests/support/run-$command.sh"
    ;;
  all)
    "$root/tests/local.sh" prepare
    "$root/tests/local.sh" up
    "$root/tests/local.sh" browser
    "$root/tests/local.sh" contracts
    "$root/tests/local.sh" migration
    # Profile remains exit 2; record and assert exactly the predeclared product gap.
    profile_status=0
    "$root/tests/local.sh" interop-profile || profile_status=$?
    printf '%s\n' "$profile_status" > "$artifacts/interop-profile-exit.txt"
    compose run --rm --no-deps test node tests/support/assert-interop-profile.mjs /app/artifacts/interop-profile.json "$profile_status" /app/artifacts/interop-profile-acceptance.json
    "$root/tests/local.sh" plc-recovery
    "$root/tests/local.sh" process-crash
    "$root/tests/local.sh" authority-drills
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
    echo 'Usage: ./tests/local.sh fresh|prepare|up|browser|contracts|database-contracts|database-profile|migration|migration-resume|reverify|interop-profile|plc-recovery|process-crash|authority-drills|resilience|all|status|down'
    echo 'all requires a fresh project fixture; down retains state and volumes. No implicit reset.'
    ;;
esac
