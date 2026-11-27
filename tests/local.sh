#!/usr/bin/env bash
# Only this project's sandbox is controlled; application execution stays in containers.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# This dedicated destructive scenario must not even create an inherited checkout
# or write to an inherited report directory before allocating its own group.
if [[ ${1:-} == incoming-before-signed-submit || ${1:-} == incoming-after-signed-publication || ${1:-} == incoming-stock || ( ${1:-} == fresh-group && ( ${2:-} == _incoming-before-signed-submit-run || ${2:-} == _incoming-after-signed-publication-run || ${2:-} == _incoming-stock-run ) ) ]]; then
  unset SANDBOX_CHECKOUT SANDBOX_PROJECT ACCEPTANCE_REPORT_DIR KEEP_FAILED_SANDBOX INCOMING_RESTART_CUTPOINT
fi
# Internal execution is permitted only through the private controller manifest.
if [[ ( ${1:-} == _incoming-before-signed-submit-run || ${1:-} == _incoming-after-signed-publication-run || ${1:-} == _incoming-stock-run ) && -z ${INCOMING_OWNER_MANIFEST:-} ]]; then
  echo 'Missing incoming controller ownership' >&2; exit 2
fi
sandbox=${SANDBOX_CHECKOUT:-"$root/tests/.runtime/atmosphereinabox"}
project=${SANDBOX_PROJECT:-hypercerts-entryway}
artifacts=${ACCEPTANCE_REPORT_DIR:-"$root/tests/artifacts"}
export SANDBOX_CHECKOUT="$sandbox" SANDBOX_PROJECT="$project" ACCEPTANCE_REPORT_DIR="$artifacts"
[[ "$project" =~ ^hypercerts-entryway(-[a-z0-9_-]+)?$ ]] || { echo "Invalid Entryway project name" >&2; exit 2; }
command=${1:-help}
# Reject invalid selectors before Docker or sandbox provisioning.
if [[ ${DATABASE_DOMAIN+x} ]]; then
  node "$root/tests/support/database-domains.mjs" --validate "$DATABASE_DOMAIN"
fi
if [[ ${1:-} == _incoming-before-signed-submit-run || ${1:-} == _incoming-after-signed-publication-run || ${1:-} == _incoming-stock-run || ( ${ENTRYWAY_INCOMING_RESTART:-0} == 1 && ( ${1:-} == prepare || ${1:-} == up ) ) ]]; then
  node "$root/tests/support/incoming-owner-guard.mjs" "$root" "${INCOMING_OWNER_MANIFEST:-}" "$project" "$sandbox" "${ENTRYWAY_DOCKER_CONTEXT:-rootless}" || exit 75
fi
mkdir -p "$sandbox"
cd "$sandbox"
sandbox=$PWD
export SANDBOX_CHECKOUT="$sandbox"
mkdir -p "$artifacts"
# Phase identity comes from the controller, never from a command or request body.
case "$command" in
  incoming-before-signed-submit|incoming-after-signed-publication|incoming-stock|_incoming-before-signed-submit-run|_incoming-after-signed-publication-run|_incoming-stock-run|transfer-history|_transfer-history-run|fresh|fresh-group|prepare|up|controller-launch|managed-create-barrier|_incoming-late-cutover-run|contracts|database-contracts|database-dialects|registry-bootstrap|registry-operator|registry-qualification|resilience-profiles|database-profile|browser|incoming-late-cutover|incoming-public-mechanisms|incoming-public-journey|incoming-public-shapes|incoming-public-failures|incoming-two-node|cross-entry-incoming-first|cross-entry-managed-first|account-lifecycle-two-node|incoming-goat-journey|incoming-moover-journey|incoming-arrival-live|migration|migration-empty|migration-resume|resilience|reverify|interop-profile|interop-acceptance|plc-recovery|process-crash|managed-recovery|authority-drills|all|down|status|help) ;;
  *) echo 'code=UNKNOWN_PHASE'; exit 2 ;;
esac
printf 'phase=%s status=started\n' "$command"
trap 'result=$?; printf "phase=%s status=finished exit=%s\n" "$command" "$result"' EXIT
source "$root/tests/support/rootless-docker.sh"
compose() { docker --context "$DOCKER_CONTEXT" compose --project-name "$project" -f "$sandbox/compose.yaml" -f "$root/tests/atmosphere/stacks/incoming-source-mail.yaml" "$@"; }
# The moover service sits behind a compose profile, and `down` without that
# profile leaves it running while still exiting 0.
remove_moover() { compose --profile moover rm --stop --force pds-moover; }
# Scoped by compose project label, so no other project is ever considered.
assert_project_empty() {
  local leftover
  leftover=$(docker --context "$DOCKER_CONTEXT" ps --all --quiet --filter "label=com.docker.compose.project=$1") || return 1
  [[ -z "$leftover" ]] || { echo "Containers of project $1 survived teardown" >&2; return 1; }
}
guard_incoming_owner() {
  node "$run_guard_root/tests/support/incoming-owner-guard.mjs" "$run_guard_root" "$INCOMING_OWNER_MANIFEST" "$SANDBOX_PROJECT" "$SANDBOX_CHECKOUT" "$DOCKER_CONTEXT" "${1:-}" || return 75
}
guard_incoming_compose() {
  node "$run_guard_root/tests/support/incoming-compose-guard.mjs" "$DOCKER_CONTEXT" "$SANDBOX_PROJECT" "$SANDBOX_CHECKOUT" "$run_guard_root" || return 75
}
run_guard_root="$root"
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
  const matches = definition.routes.filter(item => item.id === id && [service].flat().includes(item.service))
  if (matches.length !== 1 || !matches[0].host || matches[0].hostname) throw new Error('Invalid configured route')
  return `https://${matches[0].host}.${manifest.domain}`
}
console.log([source[0].url, route(entryway, 'entryway', 'entryway-ingress'), route(entryway, 'cluster1', 'pds1'), route(entryway, 'cluster2', 'pds2'), manifest.plc, route(fixtures, 'mailpit', 'mail-capture')].join(' '))
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
  transfer-history)
    export ENTRYWAY_TRANSFER_HISTORY=1
    exec "$root/tests/local.sh" fresh-group _transfer-history-run
    ;;
  _transfer-history-run)
    require_state
    run="$(date +%s)-$$"
    image=$(docker --context "$DOCKER_CONTEXT" inspect "${project}-pds1-1" --format '{{.Image}}')
    for host in pds2 pds-history-c; do
      [[ "$(docker --context "$DOCKER_CONTEXT" inspect "${project}-${host}-1" --format '{{.Image}}')" == "$image" ]] || { echo 'Managed PDS image mismatch' >&2; exit 1; }
    done
    printf 'managed-pds-image=%s hosts=3\n' "$image"
    entry_image=$(docker --context "$DOCKER_CONTEXT" inspect "${project}-entryway-1" --format '{{.Image}}')
    browser_image=$(docker --context "$DOCKER_CONTEXT" image inspect "$project-browser:local" --format '{{.Id}}')
    for path in tests/browser/transfer-history.spec.mjs tests/playwright.config.mjs; do
      expected=$(sha256sum "$root/$path" | cut -d' ' -f1)
      actual=$(docker --context "$DOCKER_CONTEXT" run --rm --entrypoint sha256sum "$project-browser:local" "/app/$path" | cut -d' ' -f1)
      [[ "$expected" == "$actual" ]] || { echo "Image source mismatch: $path" >&2; exit 1; }
      printf 'source-image-sha256 path=%s sha256=%s image=%s\n' "$path" "$actual" "$browser_image"
    done
    for host in entryway pds1 pds2 pds-history-c; do
      path=tests/support/configure.mjs
      expected=$(sha256sum "$root/$path" | cut -d' ' -f1)
      actual=$(docker --context "$DOCKER_CONTEXT" exec "${project}-${host}-1" sha256sum "/app/$path" | cut -d' ' -f1)
      [[ "$expected" == "$actual" ]] || { echo "Container source mismatch: $host $path" >&2; exit 1; }
      printf 'source-container-sha256 host=%s path=%s sha256=%s\n' "$host" "$path" "$actual"
    done
    printf 'entryway-image=%s\n' "$entry_image"
    sha256sum "$root/tests/local.sh" "$root/tests/atmosphere/install.py"
    compose run --rm --no-deps -e TRANSFER_HISTORY_PHASE=before -e "TRANSFER_HISTORY_RUN=$run" -e TRANSFER_HISTORY=1 browser npx --no-install playwright test --config tests/playwright.config.mjs
    id=$(compose ps --quiet entryway)
    [[ -n "$id" && "$id" != *$'\n'* ]] || exit 1
    before=$(docker --context "$DOCKER_CONTEXT" inspect --format '{{.Image}} {{.State.StartedAt}}' "$id")
    compose restart entryway
    [[ "$(compose ps --quiet entryway)" == "$id" ]] || { echo 'code=CONTAINER_RECREATED' >&2; exit 1; }
    after=$(docker --context "$DOCKER_CONTEXT" inspect --format '{{.Image}} {{.State.StartedAt}}' "$id")
    [[ "${before%% *}" == "${after%% *}" && "${before#* }" != "${after#* }" ]] || { echo 'code=RESTART_NOT_OBSERVED' >&2; exit 1; }
    for attempt in {1..60}; do
      [[ "$(docker --context "$DOCKER_CONTEXT" inspect --format '{{.State.Health.Status}}' "$id")" == healthy ]] && break
      sleep 2
    done
    [[ "$(docker --context "$DOCKER_CONTEXT" inspect --format '{{.State.Health.Status}}' "$id")" == healthy ]] || { echo 'code=RESTART_NOT_READY' >&2; exit 1; }
    echo 'entryway-restart=same-container-same-image'
    compose run --rm --no-deps -e TRANSFER_HISTORY_PHASE=after -e "TRANSFER_HISTORY_RUN=$run" -e TRANSFER_HISTORY=1 browser npx --no-install playwright test --config tests/playwright.config.mjs
    compose exec -T -e "TRANSFER_HISTORY_RUN=$run" entryway node --input-type=module - <<'JS'
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new Database('/data/account-authority.sqlite', { readonly: true, fileMustExist: true });
const get = db.prepare('SELECT value FROM key_value_state WHERE namespace = ? AND key = ?');
for (const shape of ['empty', 'populated']) {
  const saved = JSON.parse(readFileSync(`/app/artifacts/transfer-history-${process.env.TRANSFER_HISTORY_RUN}-${shape}.json`, 'utf8'));
  for (const operation of saved.operations) {
    const row = get.get('migration:history', operation.id);
    assert.ok(row);
    const history = JSON.parse(row.value);
    for (const field of ['id', 'did', 'phase', 'sourcePdsId', 'targetPdsId']) assert.equal(history[field], operation[field]);
    assert.equal(history.phase, 'complete');
  }
  console.log(`transfer-history shape=${shape} persisted-history=verified`);
}
db.close();
JS
    ;;
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
    start_group incoming incoming-public-journey incoming-public-failures
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
        _incoming-before-signed-submit-run|_incoming-after-signed-publication-run|_incoming-stock-run|_transfer-history-run|registry-bootstrap|registry-operator|registry-qualification|browser|contracts|incoming-late-cutover|incoming-public-mechanisms|incoming-public-journey|incoming-public-shapes|incoming-public-failures|incoming-two-node|cross-entry-incoming-first|cross-entry-managed-first|account-lifecycle-two-node|incoming-goat-journey|incoming-moover-journey|database-contracts|migration|migration-empty|reverify|interop-profile|interop-acceptance|plc-recovery|process-crash|managed-recovery|authority-drills|resilience) ;;
        *) echo "Unknown fresh-group step: $step" >&2; exit 2 ;;
      esac
    done
    # The two-node profile is chosen at install time and start-up, so its
    # settings are exported here, before prepare and up, for every child step.
    # It runs alone: the other steps assume one Entryway container.
    for step in "$@"; do
      if [[ "$step" == _incoming-stock-run ]]; then
        (( $# == 1 )) || { echo 'incoming-stock runs in its own fresh group' >&2; exit 2; }
        unset ENTRYWAY_LATE_CUTOVER ENTRYWAY_TRANSFER_HISTORY
      fi
      if [[ "$step" == incoming-late-cutover || "$step" == _incoming-before-signed-submit-run || "$step" == _incoming-after-signed-publication-run ]]; then
        (( $# == 1 )) || { echo 'incoming-late-cutover runs in its own fresh group' >&2; exit 2; }
        export ENTRYWAY_LATE_CUTOVER=1
      fi
      if [[ "$step" == incoming-two-node || "$step" == cross-entry-incoming-first || "$step" == cross-entry-managed-first || "$step" == account-lifecycle-two-node ]]; then
        (( $# == 1 )) || { echo 'two-node journey runs alone in its own group' >&2; exit 2; }
        export DATABASE_BACKEND=postgresql DEPLOYMENT_MODE=multi-node ENTRYWAY_PROFILE_NODE_COUNT=2
        export DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority
      fi
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
    [[ ! -L "$root/tests/.runtime" && "$(realpath "$root/tests/.runtime")" == "$root/tests/.runtime" ]] || { echo "Invalid runtime directory" >&2; exit 1; }
    incoming_owned=0
    if [[ "$*" == _incoming-before-signed-submit-run || "$*" == _incoming-after-signed-publication-run || "$*" == _incoming-stock-run ]]; then
      incoming_owned=1
      export ENTRYWAY_INCOMING_RESTART=1 DATABASE_BACKEND=sqlite DEPLOYMENT_MODE=single-node
      unset DATABASE_URL ENTRYWAY_PROFILE_NODE_COUNT
      temp=$(mktemp -d "$root/tests/.runtime/incoming-XXXXXXXXXXXXXXXXXXXXXXXX")
    else
      temp=$(mktemp -d "$root/tests/.runtime/hypercerts-entryway-e2e.XXXXXX")
    fi
    export SANDBOX_CHECKOUT="$temp/atmosphereinabox"
    if [[ "$*" == _incoming-before-signed-submit-run || "$*" == _incoming-after-signed-publication-run || "$*" == _incoming-stock-run ]]; then
      # Derive all destructive targets from an exclusively-created directory,
      # not from inherited selectors. Refuse even an improbable Docker collision.
      export SANDBOX_PROJECT="hypercerts-entryway-$(basename "$temp" | sha256sum | cut -c1-32)"
      export ACCEPTANCE_REPORT_DIR="$root/tests/artifacts/$SANDBOX_PROJECT"
      unset KEEP_FAILED_SANDBOX
      for resource in container volume network; do
        args=(); [[ "$resource" != container ]] || args+=(--all)
        existing=$(docker --context "$DOCKER_CONTEXT" "$resource" ls "${args[@]}" -q --filter "label=com.docker.compose.project=$SANDBOX_PROJECT") || { rm -rf -- "$temp"; exit 1; }
        [[ -z "$existing" ]] || { echo 'Fresh project already has resources' >&2; rm -rf -- "$temp"; exit 1; }
      done
      for tag in "$SANDBOX_PROJECT:local" "$SANDBOX_PROJECT-late-cutover-pds:local" "$SANDBOX_PROJECT-browser:local" "$SANDBOX_PROJECT-pds-moover:local" "$SANDBOX_PROJECT-entryway-browser-client:latest" "$SANDBOX_PROJECT-entryway-oauth-web-app:latest"; do
        existing=$(docker --context "$DOCKER_CONTEXT" image ls -q --filter "reference=$tag") || { rm -rf -- "$temp"; exit 1; }
        [[ -z "$existing" ]] || { echo 'Fresh project already has an image tag' >&2; rm -rf -- "$temp"; exit 1; }
      done
      mkdir -p "$ACCEPTANCE_REPORT_DIR"
      mkdir "$SANDBOX_CHECKOUT"
      export INCOMING_OWNER_MANIFEST="$temp/owner.json"
      node --input-type=module - "$INCOMING_OWNER_MANIFEST" "$SANDBOX_PROJECT" "$SANDBOX_CHECKOUT" "$DOCKER_CONTEXT" <<'JS'
import { writeFileSync } from 'node:fs'
const [path, project, checkout, context] = process.argv.slice(2)
writeFileSync(path, JSON.stringify({ project, checkout, context }), { mode: 0o600, flag: 'wx' })
JS
      tree=$(git -C "$root" write-tree)
      mkdir "$temp/source"
      git -C "$root" archive "$tree" | tar -x -C "$temp/source"
      git -C "$root" ls-tree -r --name-only "$tree" -- src tests/browser/incoming-late-cutover.spec.mjs tests/browser/incoming-public-journey.spec.mjs tests/support/helpers tests/playwright.config.mjs package.json package-lock.json > "$temp/source-files"
      printf '%s\n' "$tree" > "$ACCEPTANCE_REPORT_DIR/source-tree.txt"
      cp "$temp/source-files" "$ACCEPTANCE_REPORT_DIR/source-files.txt"
      export INCOMING_SOURCE_FILES="$temp/source-files"
      run_root="$temp/source"
      run_guard_root="$run_root"
    else
      run_root="$root"
    fi
    cleanup() {
      result=$?
      if (( incoming_owned && result == 75 )); then
        echo "Guard rejected this run; preserved $temp without teardown" >&2
        exit 75
      fi
      if (( incoming_owned )) && ! { guard_incoming_owner state && guard_incoming_compose; }; then
        echo "Ownership not established; preserved $temp without teardown" >&2
        exit 1
      fi
      if (( result != 0 )) && [[ "${KEEP_FAILED_SANDBOX:-0}" == 1 ]]; then
        echo "Preserved project $SANDBOX_PROJECT at $temp" >&2
      else
        if [[ -f "$SANDBOX_CHECKOUT/compose.yaml" ]] \
          && ! { docker --context "$DOCKER_CONTEXT" compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" -f "$run_root/tests/atmosphere/stacks/incoming-source-mail.yaml" --profile '*' down --volumes --remove-orphans \
            && assert_project_empty "$SANDBOX_PROJECT"; }; then
          echo "Scoped cleanup failed; preserved $temp for project $SANDBOX_PROJECT" >&2
          (( result != 0 )) || result=1
          echo "Group exit: $result; reports: $ACCEPTANCE_REPORT_DIR"
          exit "$result"
        fi
        if [[ "${ENTRYWAY_TRANSFER_HISTORY:-0}" == 1 ]] || (( incoming_owned )); then
          tags_absent=1
          for tag in "$SANDBOX_PROJECT:local" "$SANDBOX_PROJECT-late-cutover-pds:local" "$SANDBOX_PROJECT-browser:local" "$SANDBOX_PROJECT-pds-moover:local" "$SANDBOX_PROJECT-entryway-browser-client:latest" "$SANDBOX_PROJECT-entryway-oauth-web-app:latest"; do
            existing=$(docker --context "$DOCKER_CONTEXT" image ls -q --filter "reference=$tag") || { result=1; tags_absent=0; continue; }
            if [[ -n "$existing" ]]; then
              docker --context "$DOCKER_CONTEXT" image rm "$tag" || { result=1; tags_absent=0; }
            fi
            existing=$(docker --context "$DOCKER_CONTEXT" image ls -q --filter "reference=$tag") || { result=1; tags_absent=0; continue; }
            if [[ -n "$existing" ]]; then
              echo "Image tag survived cleanup: $tag" >&2
              result=1
              tags_absent=0
            else
              printf 'image-tag-absent=%s\n' "$tag"
            fi
          done
          (( tags_absent == 0 )) || echo 'project-image-tags=absent'
          for resource in volume network; do
            leftover=$(docker --context "$DOCKER_CONTEXT" "$resource" ls -q --filter "label=com.docker.compose.project=$SANDBOX_PROJECT") || { result=1; continue; }
            if [[ -n "$leftover" ]]; then echo "Project $resource survived cleanup" >&2; result=1; else echo "project-$resource=absent"; fi
          done
        fi
        rm -rf -- "$temp"
        if [[ -e "$temp" ]]; then echo 'Checkout survived cleanup' >&2; result=1; else echo 'disposable-checkout=absent'; fi
      fi
      echo "Group exit: $result; reports: $ACCEPTANCE_REPORT_DIR"
      exit "$result"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    "$run_root/tests/local.sh" prepare
    if (( incoming_owned )); then
      guard_incoming_owner state || exit 75
      guard_incoming_compose || exit 75
    fi
    "$run_root/tests/local.sh" up
    for step in "$@"; do
      echo "== $step"
      if [[ "$step" == incoming-late-cutover ]]; then
        "$root/tests/local.sh" _incoming-late-cutover-run
      else
        "$run_root/tests/local.sh" "$step"
      fi
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
    if [[ "${ENTRYWAY_INCOMING_RESTART:-0}" == 1 ]]; then
      guard_incoming_owner state || exit 75
      guard_incoming_compose || exit 75
    fi
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
  managed-create-barrier)
    require_state
    shift
    [[ "${1:-}" == -- ]] && shift
    bash "$root/tests/support/run-managed-create-barrier.sh" "$root" "$sandbox" "$project" "$@"
    ;;
  controller-launch)
    require_state
    [[ "${ENTRYWAY_LATE_CUTOVER:-0}" == 1 ]] || { echo 'Controller launch test requires a disposable staged sandbox' >&2; exit 2; }
    mode=${2:-test}
    [[ $# -le 2 && ( "$mode" == test || "$mode" == cleanup ) ]] || { echo 'Usage: ./tests/local.sh controller-launch [cleanup]' >&2; exit 2; }
    "$root/tests/support/run-controller-launch.sh" "$root" "$sandbox" "$project" "$mode"
    ;;
  incoming-before-signed-submit)
    export ENTRYWAY_INCOMING_RESTART=1
    exec "$root/tests/local.sh" fresh-group _incoming-before-signed-submit-run
    ;;
  incoming-after-signed-publication)
    exec "$root/tests/local.sh" fresh-group _incoming-after-signed-publication-run
    ;;
  incoming-stock)
    exec "$root/tests/local.sh" fresh-group _incoming-stock-run
    ;;
  _incoming-stock-run)
    guard_incoming_owner state
    guard_incoming_compose
    expected=$(mktemp "$sandbox/.stock-expected.XXXXXX")
    browser_hashes=$(mktemp "$sandbox/.stock-browser.XXXXXX")
    entryway_hashes=$(mktemp "$sandbox/.stock-entryway.XXXXXX")
    (cd "$root" && xargs -d '\n' sha256sum < "$INCOMING_SOURCE_FILES") > "$expected"
    docker --context "$DOCKER_CONTEXT" run --rm -i --entrypoint sh "$project-browser:local" -c 'cd /app && xargs -d "\n" sha256sum' < "$INCOMING_SOURCE_FILES" > "$browser_hashes"
    docker --context "$DOCKER_CONTEXT" exec -i "${project}-entryway-1" sh -c 'cd /app && xargs -d "\n" sha256sum' < "$INCOMING_SOURCE_FILES" > "$entryway_hashes"
    cmp "$expected" "$browser_hashes"
    cmp "$expected" "$entryway_hashes"
    pds1=$(docker --context "$DOCKER_CONTEXT" inspect "${project}-pds1-1" --format '{{.Image}}')
    pds2=$(docker --context "$DOCKER_CONTEXT" inspect "${project}-pds2-1" --format '{{.Image}}')
    pds3=$(docker --context "$DOCKER_CONTEXT" inspect "${project}-pds3-1" --format '{{.Image}}')
    node --input-type=module - "$ACCEPTANCE_REPORT_DIR/stock-provenance.json" "$project" "$pds1" "$pds2" "$pds3" <<'JS'
import { writeFileSync } from 'node:fs'
const [path, project, pds1, pds2, pds3] = process.argv.slice(2)
writeFileSync(path, JSON.stringify({ project, sourceParity: { browser: true, entryway: true }, runtimePdsImageIds: { pds1, pds2, pds3 } }, null, 2) + '\n')
JS
    rm -f "$expected" "$browser_hashes" "$entryway_hashes"
    exec "$root/tests/local.sh" incoming-public-journey
    ;;
  _incoming-before-signed-submit-run|_incoming-after-signed-publication-run)
    guard_incoming_owner state
    guard_incoming_compose
    require_state
    prepare_incoming_access
    cutpoint=before
    [[ "$command" != _incoming-after-signed-publication-run ]] || cutpoint=after
    bash "$root/tests/support/run-incoming-before-signed-submit.sh" "$root" "$sandbox" "$project" "$DOCKER_CONTEXT" "$cutpoint"
    ;;
  incoming-late-cutover)
    exec "$root/tests/local.sh" fresh-group incoming-late-cutover
    ;;
  _incoming-late-cutover-run)
    require_state
    prepare_incoming_access
    private=$(mktemp -d "$sandbox/.staged-controller.XXXXXX")
    results=$(mktemp "$sandbox/.staged-results.XXXXXX")
    node "$root/tests/support/staged-qualification.mjs" before "$project" "$private"
    compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" \
      --volume "$results:/qualification-results.json" -e STAGED_QUALIFICATION_RESULTS=/qualification-results.json \
      -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e INCOMING_LATE_CUTOVER=1 \
      browser npx --no-install playwright test --config tests/playwright.config.mjs 2>&1 | tee "$artifacts/incoming-late-cutover.log" | python3 "$root/scripts/ci-summary.py"
    mv "$results" "$private/staged-qualification-results.json"
    node "$root/tests/support/staged-qualification.mjs" after "$project" "$private"
    receipt="$artifacts/staged-qualification-$(basename "$private").json"
    cp "$private/staged-qualification.json" "$receipt"
    echo "Staged observation: $receipt"
    ;;
  contracts)
    require_state
    compose run --rm --no-deps test node tests/support/smtp-tls-relay.mjs
    compose run --rm --no-deps test node tests/support/smtp-data-faults.mjs
    compose run --rm --no-deps test node tests/support/run-contracts.mjs 2>&1 | tee "$artifacts/contracts.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  database-contracts|database-dialects)
    require_state
    compose up -d --wait entryway-postgres
    # The suites share no state: SQLite uses in-memory databases in its own
    # container, PostgreSQL gives each test a private schema, and each writes
    # distinct report files. Output goes to per-backend logs so the two runs
    # cannot interleave; summaries print after both finish.
    printf "Database domain=%s backends=sqlite,postgresql\n" "${DATABASE_DOMAIN:-all}"
    pids=()
    concurrency_env=()
    if [[ -n "${DATABASE_CONTRACT_CONCURRENCY:-}" ]]; then
      concurrency_env=(-e "DATABASE_CONTRACT_CONCURRENCY=$DATABASE_CONTRACT_CONCURRENCY")
    fi
    backends=(sqlite postgresql)
    for backend in "${backends[@]}"; do
      (
        result=0
        compose run --rm --no-deps "${concurrency_env[@]}" -e "DATABASE_DOMAIN=${DATABASE_DOMAIN:-}" -e "CONTRACT_DATABASE_BACKEND=$backend" -e CONTRACT_DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority test node tests/support/run-database-contracts.mjs > "$artifacts/database-${DATABASE_DOMAIN:-all}-$backend.log" 2>&1 || result=$?
        printf '%s\n' "$result" > "$artifacts/database-${DATABASE_DOMAIN:-all}-$backend.exit"
        exit "$result"
      ) &
      pids+=("$!")
    done
    failed=0
    for i in "${!backends[@]}"; do
      backend=${backends[$i]}
      result=0
      wait "${pids[$i]}" || result=$?
      python3 "$root/scripts/ci-summary.py" < "$artifacts/database-${DATABASE_DOMAIN:-all}-$backend.log" || true
      echo "Database domain=${DATABASE_DOMAIN:-all} backend=$backend exit=$result"
      (( result == 0 )) || failed=$result
    done
    (( failed == 0 )) || exit "$failed"
    if [[ "$command" == database-contracts ]]; then
      echo 'Database standalone PostgreSQL profile: running'
      bash "$root/tests/support/run-postgresql-profile.sh"
      echo 'Database standalone PostgreSQL profile: passed'
    else
      echo 'Database standalone PostgreSQL profile: skipped (database-dialects)'
    fi
    ;;
  registry-bootstrap|registry-operator|registry-qualification)
    require_state
    [[ "$project" != hypercerts-entryway ]] || { echo 'Use a dedicated sandbox project for registry bootstrap' >&2; exit 2; }
    prepare_incoming_access
    bash "$root/tests/support/run-registry-bootstrap.sh" "${command#registry-}"
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
  incoming-public-mechanisms|incoming-arrival-live)
    require_state
    prepare_incoming_access
    suite=incoming-public-mechanisms
    if [[ "$command" == incoming-arrival-live ]]; then suite=incoming-arrival-live; fi
    compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e INCOMING_PUBLIC_MECHANISMS=1 browser node --test "tests/contracts/$suite.test.mjs"
    if [[ "$command" == incoming-arrival-live ]]; then
      # The disposable dispatcher exited above; stop both owned target workers
      # before permitting observation of either uncertain applied effect.
      compose stop pds1 pds2
      compose up -d --wait pds1 pds2
      compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e INCOMING_PUBLIC_MECHANISMS=1 -e INCOMING_RECOVERY=1 -e INCOMING_DISPATCHER_EXIT_REFERENCE=owned-dispatcher-container-exited-0-and-removed -e INCOMING_UPSTREAM_DRAIN_REFERENCE=owned-pds1-pds2-stopped-then-healthy browser node --test --test-name-pattern='stock applied' tests/contracts/incoming-arrival-live.test.mjs
    fi
    ;;
  incoming-public-journey|incoming-public-shapes)
    require_state
    prepare_incoming_access
    selection=INCOMING_PUBLIC_JOURNEY
    if [[ "$command" == incoming-public-shapes ]]; then selection=INCOMING_PUBLIC_SHAPES; fi
    # The public browser/API journey: one Playwright spec, selected explicitly
    # because it needs this project's access projection and mail capture.
    compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e "$selection=1" browser npx --no-install playwright test --config tests/playwright.config.mjs 2>&1 | tee "$artifacts/$command.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  account-lifecycle-two-node)
    require_state
    [[ "${DATABASE_BACKEND:-}" == postgresql && "${DEPLOYMENT_MODE:-}" == multi-node && "${ENTRYWAY_PROFILE_NODE_COUNT:-}" == 2 && -n "${DATABASE_URL:-}" ]] \
      || { echo 'account-lifecycle-two-node needs the two-node PostgreSQL profile; run ./tests/local.sh fresh-group account-lifecycle-two-node' >&2; exit 2; }
    compose run --rm --no-deps -e ACCOUNT_LIFECYCLE_TWO_NODE=1 browser npx --no-install playwright test --config tests/playwright.config.mjs 2>&1 | tee "$artifacts/account-lifecycle-two-node.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  cross-entry-managed-first)
    require_state
    prepare_incoming_access
    bash "$root/tests/support/run-managed-create-barrier.sh" "$root" "$sandbox" "$project" \
      env CROSS_ENTRY_MANAGED_FIRST=1 INCOMING_ACCESS_PATH=/run/incoming-access.json "INCOMING_PROJECT=$project" \
      npx --no-install playwright test --config tests/playwright.config.mjs 2>&1 | tee "$artifacts/cross-entry-managed-first.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  cross-entry-incoming-first)
    require_state
    [[ "${DATABASE_BACKEND:-}" == postgresql && "${DEPLOYMENT_MODE:-}" == multi-node && "${ENTRYWAY_PROFILE_NODE_COUNT:-}" == 2 && -n "${DATABASE_URL:-}" ]] || { echo 'cross-entry-incoming-first needs the two-node PostgreSQL profile' >&2; exit 2; }
    prepare_incoming_access
    compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e CROSS_ENTRY_INCOMING_FIRST=1 browser npx --no-install playwright test --config tests/playwright.config.mjs 2>&1 | tee "$artifacts/cross-entry-incoming-first.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  incoming-two-node)
    require_state
    # One-off evidence, not a CI gate. The deployment must already be the
    # two-node PostgreSQL profile, prepared and started with these settings
    # (fresh-group exports them); the spec also requires two ready nodes.
    [[ "${DATABASE_BACKEND:-}" == postgresql && "${DEPLOYMENT_MODE:-}" == multi-node && "${ENTRYWAY_PROFILE_NODE_COUNT:-}" == 2 && -n "${DATABASE_URL:-}" ]] \
      || { echo 'incoming-two-node needs the two-node PostgreSQL profile; run ./tests/local.sh fresh-group incoming-two-node' >&2; exit 2; }
    prepare_incoming_access
    # The journey runs once per node order, as two Playwright projects.
    compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e INCOMING_TWO_NODE=1 browser npx --no-install playwright test --config tests/playwright.config.mjs 2>&1 | tee "$artifacts/incoming-two-node.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  incoming-public-failures)
    require_state
    prepare_incoming_access
    # Specs run inside the browser container and cannot restart services, so
    # the restart case runs as two browser phases with an Entryway restart in
    # between. Its cross-phase state (source session, arrival code) is one file
    # in a private directory outside the artifact directory, removed whatever
    # the outcome.
    failure_state=$(mktemp -d "$sandbox/.incoming-failures.XXXXXX")
    trap 'result=$?; rm -rf -- "$failure_state" || (( result )) || result=1; printf "phase=%s status=finished exit=%s\n" "$command" "$result"; exit "$result"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    failures() {
      printf 'failure-phase=%s status=started\n' "$1"
      compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" --volume "$failure_state:/run/incoming-failures" -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e INCOMING_PUBLIC_FAILURES=1 -e "INCOMING_FAILURES_PHASE=$1" -e INCOMING_FAILURES_STATE=/run/incoming-failures/restart.json browser npx --no-install playwright test --config tests/playwright.config.mjs 2>&1 | tee "$artifacts/incoming-public-failures-$1.log" | python3 "$root/scripts/ci-summary.py"
    }
    # The one Entryway container's start time, to prove the restart happened.
    entryway_started() {
      local id
      id=$(compose ps --quiet entryway) || return 1
      [[ -n "$id" && "$id" != *$'\n'* ]] || { echo 'Expected exactly one Entryway container' >&2; return 1; }
      docker --context "$DOCKER_CONTEXT" inspect --format '{{.State.StartedAt}}' "$id"
    }
    # The restart halves run apart from the other cases and run even when a
    # case fails; after-restart needs a passing before-restart. The command
    # fails if any phase does.
    cases=0
    failures cases || cases=$?
    failures before-restart
    started=$(entryway_started)
    compose restart entryway
    compose up -d --wait entryway
    restarted=$(entryway_started)
    [[ -n "$started" && -n "$restarted" && "$restarted" != "$started" ]] || { echo 'code=RESTART_NOT_OBSERVED' >&2; exit 1; }
    echo 'entryway-restart=observed'
    failures after-restart
    (( cases == 0 )) || exit "$cases"
    ;;
  incoming-goat-journey)
    require_state
    prepare_incoming_access
    # Build the patched public goat CLI from its pinned commit (tests/support/goat)
    # and mount only the static binary; the browser container's sandbox CA keeps
    # TLS verification on.
    goat_dir="$sandbox/goat-client"
    mkdir -p "$goat_dir"
    docker --context "$DOCKER_CONTEXT" build --quiet --output "type=local,dest=$goat_dir" "$root/tests/support/goat"
    compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" --volume "$goat_dir/goat:/usr/local/bin/goat:ro" -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e INCOMING_GOAT_JOURNEY=1 browser npx --no-install playwright test --config tests/playwright.config.mjs 2>&1 | tee "$artifacts/incoming-goat-journey.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  incoming-moover-journey)
    require_state
    prepare_incoming_access
    # The PDS MOOver web UI, built from its pinned commit (tests/support/pds-moover)
    # and served at its own sandbox route, so the source PDS can fetch its OAuth
    # client metadata over the sandbox CA. Started on demand by its profile.
    moover_url=$(node --input-type=module - "$root/tests/sandbox.json" "$root/tests/atmosphere/stacks/hypercerts-entryway.definition.json" <<'JS'
import { readFileSync } from 'node:fs'
const [, definition] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')))
const matches = definition.routes.filter(item => item.id === 'moover' && item.service === 'pds-moover')
// The stock PDS authorization server refuses client IDs on local TLDs such as .test.
if (matches.length !== 1 || !matches[0].hostname?.endsWith('.atmosbox.internal') || matches[0].host) throw new Error('Invalid configured moover route')
console.log(`https://${matches[0].hostname}`)
JS
    )
    # Remove the profiled container whatever the outcome of the run.
    trap 'result=$?; remove_moover || (( result )) || result=1; printf "phase=%s status=finished exit=%s\n" "$command" "$result"; exit "$result"' EXIT
    compose --profile moover up -d --build --wait --no-deps pds-moover
    compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" -e INCOMING_ACCESS_PATH=/run/incoming-access.json -e "INCOMING_PROJECT=$project" -e "MOOVER_URL=$moover_url" -e INCOMING_MOOVER_JOURNEY=1 browser npx --no-install playwright test --config tests/playwright.config.mjs 2>&1 | tee "$artifacts/incoming-moover-journey.log" | python3 "$root/scripts/ci-summary.py"
    ;;
  migration|migration-empty)
    require_state
    exec 9> "$artifacts/migration.lock"
    flock -n 9 || { echo 'Another migration flow is running' >&2; exit 2; }
    if [[ "$command" == migration-empty ]]; then
      migration_command prepare --empty
    else
      migration_command prepare
    fi
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
    migration_command reverify
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
    remove_moover
    deno task sandbox down
    # Profiled services (database, moover) survive a plain down. No --volumes: down retains state.
    compose --profile '*' down
    assert_project_empty "$project"
    ;;
  status)
    require_state
    deno task sandbox status
    ;;
  *)
    echo 'Usage: ./tests/local.sh fresh|fresh-group <steps...>|prepare|up|controller-launch|managed-create-barrier -- <browser driver command...>|browser|incoming-late-cutover|incoming-before-signed-submit|incoming-after-signed-publication|incoming-stock|incoming-public-mechanisms|incoming-public-journey|incoming-public-shapes|incoming-public-failures|incoming-two-node|cross-entry-incoming-first|cross-entry-managed-first|account-lifecycle-two-node|incoming-goat-journey|incoming-moover-journey|contracts|database-contracts|database-profile|resilience-profiles|migration|migration-empty|migration-resume|reverify|interop-profile|interop-acceptance|plc-recovery|process-crash|managed-recovery|authority-drills|resilience|all|status|down'
    echo 'all requires a fresh project fixture; down retains state and volumes. No implicit reset.'
    ;;
esac
