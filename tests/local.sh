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
sandbox=$PWD
export SANDBOX_CHECKOUT="$sandbox"
command=${1:-help}
mkdir -p "$artifacts"
# Phase identity comes from the controller, never from a command or request body.
case "$command" in
  fresh|prepare|up|contracts|database-contracts|database-dialects|resilience-profiles|database-profile|browser|incoming-public-mechanisms|migration|migration-resume|resilience|reverify|interop-profile|plc-recovery|process-crash|managed-recovery|authority-drills|all|down|status|help) ;;
  *) echo 'code=UNKNOWN_PHASE'; exit 2 ;;
esac
printf 'phase=%s status=started\n' "$command"
trap 'result=$?; printf "phase=%s status=finished exit=%s\n" "$command" "$result"' EXIT
source "$root/tests/support/rootless-docker.sh"
compose() { docker --context "$DOCKER_CONTEXT" compose --project-name "$project" -f "$sandbox/compose.yaml" -f "$root/tests/atmosphere/stacks/incoming-source-mail.yaml" "$@"; }
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
prepare_incoming_access() {
  local routes temporary
  routes=$(node --input-type=module - "$root/tests/sandbox.json" "$root/tests/atmosphere/stacks/hypercerts-entryway.definition.json" "$root/tests/atmosphere/stacks/entryway-fixtures.definition.json" <<'JS'
import { readFileSync } from 'node:fs'
const [manifest, entryway, fixtures] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')))
const source = manifest.pds.filter(pds => pds.id === 'pds3')
if (source.length !== 1 || source[0].hostname !== new URL(source[0].url).hostname) throw new Error('Invalid configured standalone PDS')
function route(definition, id, service) {
  const matches = definition.routes.filter(item => item.id === id && item.service === service)
  if (matches.length !== 1 || !matches[0].host || matches[0].hostname) throw new Error('Invalid configured route')
  return `https://${matches[0].host}.${manifest.domain}`
}
console.log([source[0].url, route(entryway, 'entryway', 'entryway'), route(entryway, 'cluster1', 'pds1'), route(entryway, 'cluster2', 'pds2'), manifest.plc, route(fixtures, 'mailpit', 'mail-capture')].join(' '))
JS
  ) || return
  local -a origins
  read -r -a origins <<< "$routes"
  deno task sandbox access --json > "$sandbox/access.json"
  node "$root/tests/atmosphere/validate-access.mjs" "$sandbox/access.json" "$project"
  temporary=$(mktemp "$sandbox/.incoming-access.XXXXXX")
  if ! node "$root/tests/atmosphere/project-incoming-access.mjs" "$sandbox/access.json" "$project" "${origins[@]}" > "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  mv -f -- "$temporary" "$sandbox/incoming-access.json"
}
browser() { compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" -e INCOMING_ACCESS_PATH=/run/incoming-access.json browser npx --no-install playwright test --config tests/playwright.config.mjs "$@"; }
external_browser() { local phase=$1; compose run --rm --no-deps -e "EXTERNAL_PHASE=$phase" browser npx --no-install playwright test --config tests/external.playwright.config.mjs 2>&1 | tee "$artifacts/external-browser-$phase.log" | python3 "$root/scripts/ci-summary.py"; }
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
        if test -f "$SANDBOX_CHECKOUT/compose.yaml" && ! docker --context "$DOCKER_CONTEXT" compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" -f "$root/tests/atmosphere/stacks/incoming-source-mail.yaml" down --volumes --remove-orphans; then
          echo "Scoped cleanup failed; preserved $temp for project $SANDBOX_PROJECT" >&2
          (( result != 0 )) || result=1
          echo "Run exit: $result; reports: $ACCEPTANCE_REPORT_DIR"
          exit "$result"
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
    compose up -d --wait --no-deps pds3
    compose build test browser
    deno task sandbox access --json > "$sandbox/access.json"
    node "$root/tests/atmosphere/validate-access.mjs" "$sandbox/access.json" "$project"
    ;;
  contracts)
    require_state
    compose run --rm --no-deps test node tests/support/run-contracts.mjs 2>&1 | tee "$artifacts/contracts.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  database-contracts|database-dialects)
    require_state
    compose up -d --wait entryway-postgres
    for backend in sqlite postgresql; do
      result=0
      compose run --rm --no-deps -e "CONTRACT_DATABASE_BACKEND=$backend" -e CONTRACT_DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority test node tests/support/run-database-contracts.mjs 2>&1 | tee "$artifacts/database-$backend.log" | python3 "$root/scripts/ci-summary.py" || result=$?
      printf '%s\n' "$result" > "$artifacts/database-$backend.exit"
      echo "Database $backend: exit $result"
      (( result == 0 )) || exit "$result"
    done
    if [[ "$command" == database-contracts ]]; then bash "$root/tests/support/run-postgresql-profile.sh"; fi
    ;;
  resilience-profiles)
    bash "$root/tests/support/run-resilience-profiles.sh"
    ;;
  database-profile)
    bash "$root/tests/support/run-postgresql-profile.sh"
    ;;
  browser)
    require_state
    prepare_incoming_access
    browser 2>&1 | tee "$artifacts/browser.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  incoming-public-mechanisms)
    require_state
    prepare_incoming_access
    compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e INCOMING_PUBLIC_MECHANISMS=1 browser node --test tests/contracts/incoming-public-mechanisms.test.mjs
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
  plc-recovery|process-crash|managed-recovery|authority-drills)
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
    "$root/tests/local.sh" managed-recovery
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
    echo 'Usage: ./tests/local.sh fresh|prepare|up|browser|incoming-public-mechanisms|contracts|database-contracts|database-profile|resilience-profiles|migration|migration-resume|reverify|interop-profile|plc-recovery|process-crash|managed-recovery|authority-drills|resilience|all|status|down'
    echo 'all requires a fresh project fixture; down retains state and volumes. No implicit reset.'
    ;;
esac
