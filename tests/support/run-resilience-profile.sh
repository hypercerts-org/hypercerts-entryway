#!/usr/bin/env bash
# One independently owned fresh managed profile. No caller's project is reused.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
profile=${1:?Select sqlite-single-node, postgresql-single-node or postgresql-multi-node}
case "$profile" in
  sqlite-single-node) export DATABASE_BACKEND=sqlite DEPLOYMENT_MODE=single-node ENTRYWAY_PROFILE_NODE_COUNT=1; unset DATABASE_URL ;;
  postgresql-single-node) export DATABASE_BACKEND=postgresql DEPLOYMENT_MODE=single-node ENTRYWAY_PROFILE_NODE_COUNT=1; export DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority ;;
  postgresql-multi-node) export DATABASE_BACKEND=postgresql DEPLOYMENT_MODE=multi-node ENTRYWAY_PROFILE_NODE_COUNT=2; export DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority ;;
  *) echo 'Invalid deployment profile' >&2; exit 2 ;;
esac
unset DATABASE_PROBE_TIMEOUT_MS SHUTDOWN_TIMEOUT_MS CONTRACT_DATABASE_URL CONTRACT_DATABASE_BACKEND
exercise_mode=${2:-}
if [[ "$exercise_mode" != --exercise ]]; then
  parent_artifacts=${ACCEPTANCE_REPORT_DIR:-"$root/tests/artifacts"}
  run="$(date +%s)-$$"
  export SANDBOX_CHECKOUT="$root/tests/.runtime/resilience-$profile-$run"
  export SANDBOX_PROJECT="hypercerts-entryway-resilience-$profile-$run"
  export ACCEPTANCE_REPORT_DIR="$parent_artifacts/resilience-$profile-$run"
  mkdir -p "$ACCEPTANCE_REPORT_DIR"
  printf '%s\n' "$SANDBOX_CHECKOUT" "$SANDBOX_PROJECT" "$ACCEPTANCE_REPORT_DIR" > "$ACCEPTANCE_REPORT_DIR/sandbox-identity.txt"
  printf '{"profile":"%s","backend":"%s","mode":"%s","nodeCount":%s,"probeMs":2000,"shutdownMs":15000,"accountLeaseMs":120000,"mailLeaseMs":30000}\n' "$profile" "$DATABASE_BACKEND" "$DEPLOYMENT_MODE" "$ENTRYWAY_PROFILE_NODE_COUNT" > "$ACCEPTANCE_REPORT_DIR/profile-configuration.json"
else
  : "${SANDBOX_CHECKOUT:?}" "${SANDBOX_PROJECT:?}" "${ACCEPTANCE_REPORT_DIR:?}"
fi
source "$root/tests/support/rootless-docker.sh"
compose() { docker --context rootless compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" "$@"; }
run() {
  local label=$1; shift
  local result=0
  printf '%q ' "$@" > "$ACCEPTANCE_REPORT_DIR/$label.command"
  printf '\n' >> "$ACCEPTANCE_REPORT_DIR/$label.command"
  if [[ -n "${exercise_deadline:-}" ]]; then (( SECONDS < exercise_deadline )) || { echo "Complete profile exercise exceeded480s" >&2; return 1; }; fi
  "$@" > "$ACCEPTANCE_REPORT_DIR/$label.log" 2>&1 || result=$?
  printf '%s\n' "$result" > "$ACCEPTANCE_REPORT_DIR/$label.exit"
  if [[ "$label" == exercise ]]; then
    printf '{"boundMs":480000,"elapsedMs":%s,"exit":%s,"terminationGraceMs":5000}\n' "$(($(date +%s%3N) - PROFILE_EXERCISE_TRIGGER_MS))" "$result" > "$ACCEPTANCE_REPORT_DIR/exercise-controller.json"
  fi
  (( result == 0 )) || { echo "$profile failed: $label (exit $result)" >&2; return "$result"; }
}
cleanup() {
  status=$?
  # Compose clients can exit while a run container still executes. Terminate only
  # this profile's explicitly labelled exercise containers; leave service state
  # available after failure. GNU timeout bounds the whole child process group.
  local containers=()
  mapfile -t containers < <(docker --context rootless ps -q \
    --filter "label=com.docker.compose.project=$SANDBOX_PROJECT" \
    --filter "label=org.hypercerts.entryway.profile-exercise=$SANDBOX_PROJECT")
  if (( ${#containers[@]} )); then
    printf '%s\n' "${containers[@]}" > "$ACCEPTANCE_REPORT_DIR/terminated-exercise-containers.txt"
    local termination_status=0
    timeout 5s docker --context rootless kill "${containers[@]}" > "$ACCEPTANCE_REPORT_DIR/exercise-termination.log" 2>&1 || termination_status=$?
    printf '%s\n' "$termination_status" > "$ACCEPTANCE_REPORT_DIR/exercise-termination.exit"
  fi
  printf '%s\n' "$status" > "$ACCEPTANCE_REPORT_DIR/profile.exit"
  if (( status == 0 )) && [[ "${KEEP_PROFILE_SANDBOX:-0}" != 1 ]]; then compose down --volumes --remove-orphans; else echo "Preserved owned profile $SANDBOX_PROJECT" >&2; fi
}
phase_container() {
  compose run --rm --no-deps --label "org.hypercerts.entryway.profile-exercise=$SANDBOX_PROJECT" "$@"
}
if [[ "$exercise_mode" != --exercise ]]; then
  trap cleanup EXIT
  run prepare "$root/tests/local.sh" prepare
  run up "$root/tests/local.sh" up
  # The deadline covers every post-startup phase, including stuck test teardown,
  # Compose startup and background browser coordination. TERM starts at480s;
  # a non-responsive controller is killed5s later. Cleanup is recorded separately.
  export PROFILE_EXERCISE_TRIGGER_MS=$(date +%s%3N)
  run exercise timeout --signal=TERM --kill-after=5s 480s bash "$0" "$profile" --exercise
  if [[ -n "${PROFILE_COLLECTION_INDEX:-}" ]]; then
    printf '%s\t%s\n' "$profile" "$(basename "$ACCEPTANCE_REPORT_DIR")" >> "$PROFILE_COLLECTION_INDEX"
  fi
  exit 0
fi
trap 'exit 143' TERM INT
browser() {
  local stage=$1 label=$2 survivor=${3:-entryway}
  local remaining=$(((exercise_deadline - SECONDS) * 1000))
  (( remaining > 0 )) || { echo "Complete profile exercise exceeded480s" >&2; return 1; }
  phase_container -e "PROFILE_REMAINING_MS=$remaining" -e "PROFILE_STAGE=$stage" -e "PROFILE_LABEL=$label" -e "PROFILE_SURVIVOR=$survivor" -e "ENTRYWAY_PROFILE_NODE_COUNT=$ENTRYWAY_PROFILE_NODE_COUNT" browser npx --no-install playwright test --config tests/profiles.playwright.config.mjs
}
probe() { phase_container -e "PROFILE_TRIGGER_MS=${PROFILE_TRIGGER_MS:-}" -e "ENTRYWAY_PROFILE_NODE_COUNT=$ENTRYWAY_PROFILE_NODE_COUNT" test node tests/support/profile-probe.mjs "$@"; }
exercise_started=$SECONDS
exercise_deadline=$((SECONDS + 480 - ($(date +%s%3N) - PROFILE_EXERCISE_TRIGGER_MS) / 1000))
for node in entryway $([[ "$ENTRYWAY_PROFILE_NODE_COUNT" == 2 ]] && echo entryway-replica); do
  run "$node-identity" compose exec -T "$node" node tests/support/profile-identity.mjs "$node"
  docker --context rootless inspect --format '{"containerId":{{json .Id}},"imageId":{{json .Image}},"hostProcessId":{{.State.Pid}},"command":{{json .Config.Cmd}}}' "$(compose ps -q "$node")" > "$ACCEPTANCE_REPORT_DIR/$node-container.json"
done
sha256sum "$SANDBOX_CHECKOUT/compose.yaml" "$SANDBOX_CHECKOUT/state/manifest.json" > "$ACCEPTANCE_REPORT_DIR/generated-inputs.sha256"
run readiness-initial probe ready readiness-initial.json
run journey browser journey journey
if [[ "$ENTRYWAY_PROFILE_NODE_COUNT" == 2 ]]; then
  run worker-takeover phase_container -e CONTRACT_DATABASE_BACKEND=postgresql -e CONTRACT_DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority test timeout --signal=TERM --kill-after=5s 195s node --test tests/contracts/profile-workers.mjs
fi
# Graceful stop is bounded separately from the application deadline. Preserve the
# real container exit and test existing sessions/direct writes on the survivor.
export PROFILE_TRIGGER_MS=$(date +%s%3N)
run graceful-stop timeout 20s docker --context rootless compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" stop --timeout 18 entryway &
stop_pid=$!
run graceful-ingress probe node-loss graceful-ingress.json
wait "$stop_pid"
unset PROFILE_TRIGGER_MS
container=$(compose ps -aq entryway)
docker --context rootless inspect --format '{{json .State}}' "$container" > "$ACCEPTANCE_REPORT_DIR/graceful-state.json"
if [[ "$ENTRYWAY_PROFILE_NODE_COUNT" == 2 ]]; then run graceful-survivor browser survivor graceful-survivor entryway-replica; fi
run graceful-rejoin timeout 30s docker --context rootless compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" start --wait entryway
run readiness-rejoin probe ready readiness-rejoin.json
run rejoin browser rejoin rejoin entryway
export PROFILE_TRIGGER_MS=$(date +%s%3N)
run kill compose kill -s SIGKILL entryway
container=$(compose ps -aq entryway)
docker --context rootless inspect --format '{{json .State}}' "$container" > "$ACCEPTANCE_REPORT_DIR/kill-state.json"
run kill-ingress probe node-loss kill-ingress.json
unset PROFILE_TRIGGER_MS
if [[ "$ENTRYWAY_PROFILE_NODE_COUNT" == 2 ]]; then run kill-survivor browser survivor kill-survivor entryway-replica; fi
run kill-rejoin timeout 30s docker --context rootless compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" start --wait entryway
run kill-rejoin-browser browser rejoin kill-rejoin entryway
wait_marker() {
  local name=$1 deadline=$((SECONDS + 30))
  until [[ -f "$ACCEPTANCE_REPORT_DIR/$name" ]]; do
    (( SECONDS < deadline )) || { echo "Missing marker $name" >&2; return 1; }
    sleep .2
  done
}
# Hold a real browser with an entered draft across refusal and recovery.
run database-browser browser database-refusal database-refusal &
browser_pid=$!
wait_marker database-fault-browser-ready.json
export PROFILE_TRIGGER_MS=$(date +%s%3N)
if [[ "$DATABASE_BACKEND" == postgresql ]]; then run database-stop compose stop --timeout 5 entryway-postgres
else run sqlite-probe-disable compose exec -T entryway node tests/support/profile-fault.mjs disable; fi
printf '{}\n' > "$ACCEPTANCE_REPORT_DIR/database-fault-active.json"
run readiness-lost probe unavailable readiness-lost.json
unset PROFILE_TRIGGER_MS
wait_marker database-fault-refusal.json
export PROFILE_TRIGGER_MS=$(date +%s%3N)
if [[ "$DATABASE_BACKEND" == postgresql ]]; then run database-start compose start entryway-postgres
else run sqlite-probe-restore compose exec -T entryway node tests/support/profile-fault.mjs restore; fi
run readiness-recovered probe ready readiness-recovered.json
unset PROFILE_TRIGGER_MS
printf '{}\n' > "$ACCEPTANCE_REPORT_DIR/database-fault-recovered.json"
wait "$browser_pid"
run final-session browser rejoin final-session entryway
run assert-profile phase_container -e "ENTRYWAY_PROFILE_NODE_COUNT=$ENTRYWAY_PROFILE_NODE_COUNT" test node tests/support/assert-resilience-profile.mjs "$profile"
(( SECONDS <= exercise_deadline )) || { echo "Complete profile exercise exceeded480s" >&2; exit 1; }
printf '{"boundSeconds":480,"elapsedMs":%s,"scope":"all journey and fault stages after startup"}\n' "$(($(date +%s%3N) - PROFILE_EXERCISE_TRIGGER_MS))" > "$ACCEPTANCE_REPORT_DIR/profile-duration.json"
echo "PASS fresh deployment profile $profile: $ACCEPTANCE_REPORT_DIR"
