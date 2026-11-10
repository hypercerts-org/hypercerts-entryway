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
# Phase identity comes from the controller, never from a command or request body.
case "$command" in
  fresh|fresh-group|prepare|up|contracts|database-contracts|database-dialects|resilience-profiles|database-profile|browser|migration|migration-resume|resilience|reverify|interop-profile|interop-acceptance|plc-recovery|process-crash|managed-recovery|authority-drills|all|down|status|help) ;;
  *) echo 'code=UNKNOWN_PHASE'; exit 2 ;;
esac
printf 'phase=%s status=started\n' "$command"
trap 'result=$?; printf "phase=%s status=finished exit=%s\n" "$command" "$result"' EXIT
source "$root/tests/support/rootless-docker.sh"
compose() { docker --context "$DOCKER_CONTEXT" compose --project-name "$project" -f "$sandbox/compose.yaml" "$@"; }
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
external_browser() { local phase=$1; compose run --rm --no-deps -e "EXTERNAL_PHASE=$phase" browser npx --no-install playwright test --config tests/external.playwright.config.mjs 2>&1 | tee "$artifacts/external-browser-$phase.log" | python3 "$root/scripts/ci-summary.py"; }
migration_command() { compose exec -T entryway node tests/support/external-migration.mjs "$@"; }
case "$command" in
  fresh)
    # Each group gets its own sandbox, so groups run in parallel without sharing
    # state. Steps inside a group stay sequential because later steps read state
    # earlier steps created (contracts and resilience read browser-made accounts)
    # or stop and restart shared containers.
    run_id="hypercerts-entryway-$(date +%s)-$$"
    report_root="$root/tests/artifacts/$run_id"
    mkdir -p "$report_root" "$root/tests/.runtime"
    pids=() names=()
    # setsid gives each group its own process group, so cancellation reaches the
    # step a group is running, not only the group shell waiting on it.
    start_group() {
      local name=$1; shift
      SANDBOX_PROJECT="$run_id-$name" ACCEPTANCE_REPORT_DIR="$report_root/$name" \
        setsid "$root/tests/local.sh" fresh-group "$@" > "$report_root/$name.log" 2>&1 &
      pids+=("$!") names+=("$name")
      echo "Started $name (log: $report_root/$name.log)"
    }
    stop_groups() {
      local pid
      for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
      wait
    }
    trap 'stop_groups; exit 130' INT
    trap 'stop_groups; exit 143' TERM
    start_group journeys browser contracts resilience
    start_group migration migration interop-acceptance
    start_group faults plc-recovery process-crash managed-recovery authority-drills
    result=0
    for i in "${!pids[@]}"; do
      status=0
      wait "${pids[$i]}" || status=$?
      echo "${names[$i]}: exit $status"
      (( status == 0 )) || result=1
    done
    echo "Run exit: $result; reports: $report_root"
    exit "$result"
    ;;
  fresh-group)
    # One disposable sandbox running the given steps in order, then removed.
    shift
    (( $# > 0 )) || { echo 'fresh-group needs at least one step' >&2; exit 2; }
    for step in "$@"; do
      case "$step" in
        browser|contracts|database-contracts|migration|interop-profile|interop-acceptance|plc-recovery|process-crash|managed-recovery|authority-drills|resilience) ;;
        *) echo "Unknown fresh-group step: $step" >&2; exit 2 ;;
      esac
    done
    # Cleanup removes the project's volumes, so never target the persistent project.
    if [[ "$SANDBOX_PROJECT" == hypercerts-entryway ]]; then
      export SANDBOX_PROJECT="hypercerts-entryway-group-$(date +%s)-$$"
      if [[ "$ACCEPTANCE_REPORT_DIR" == "$root/tests/artifacts" ]]; then
        export ACCEPTANCE_REPORT_DIR="$root/tests/artifacts/$SANDBOX_PROJECT"
        mkdir -p "$ACCEPTANCE_REPORT_DIR"
      fi
    fi
    mkdir -p "$root/tests/.runtime"
    temp=$(mktemp -d "$root/tests/.runtime/hypercerts-entryway-e2e.XXXXXX")
    export SANDBOX_CHECKOUT="$temp/atmosphereinabox"
    cleanup() {
      result=$?
      if (( result != 0 )) && [[ "${KEEP_FAILED_SANDBOX:-0}" == 1 ]]; then
        echo "Preserved project $SANDBOX_PROJECT at $temp" >&2
      else
        if [[ -f "$SANDBOX_CHECKOUT/compose.yaml" ]] \
          && ! docker --context "$DOCKER_CONTEXT" compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" down --volumes --remove-orphans; then
          echo "Scoped cleanup failed; preserved $temp for project $SANDBOX_PROJECT" >&2
          (( result != 0 )) || result=1
          echo "Group exit: $result; reports: $ACCEPTANCE_REPORT_DIR"
          exit "$result"
        fi
        rm -rf -- "$temp"
      fi
      echo "Group exit: $result; reports: $ACCEPTANCE_REPORT_DIR"
      exit "$result"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    "$root/tests/local.sh" prepare
    "$root/tests/local.sh" up
    for step in "$@"; do
      echo "== $step"
      "$root/tests/local.sh" "$step"
    done
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
    browser 2>&1 | tee "$artifacts/browser.log" | python3 "$root/scripts/ci-summary.py"
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
  interop-acceptance)
    require_state
    # Profile remains exit 2; record and assert exactly the predeclared product gap.
    profile_status=0
    "$root/tests/local.sh" interop-profile || profile_status=$?
    printf '%s\n' "$profile_status" > "$artifacts/interop-profile-exit.txt"
    compose run --rm --no-deps test node tests/support/assert-interop-profile.mjs /app/artifacts/interop-profile.json "$profile_status" /app/artifacts/interop-profile-acceptance.json
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
    "$root/tests/local.sh" interop-acceptance
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
    echo 'Usage: ./tests/local.sh fresh|fresh-group <steps...>|prepare|up|browser|contracts|database-contracts|database-profile|resilience-profiles|migration|migration-resume|reverify|interop-profile|interop-acceptance|plc-recovery|process-crash|managed-recovery|authority-drills|resilience|all|status|down'
    echo 'all requires a fresh project fixture; down retains state and volumes. No implicit reset.'
    ;;
esac
