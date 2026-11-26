#!/usr/bin/env bash
# Run one test driver with a barrier on the primary node of an owned sandbox.
set -euo pipefail
root=$1 sandbox=$2 project=$3
shift 3
(( $# > 0 )) || { echo 'A browser-container test driver command is required' >&2; exit 2; }
[[ "$project" != hypercerts-entryway ]] || { echo 'A disposable project is required' >&2; exit 2; }
[[ "${DATABASE_BACKEND:-}" == postgresql && "${DEPLOYMENT_MODE:-}" == multi-node && "${ENTRYWAY_PROFILE_NODE_COUNT:-}" == 2 && -n "${DATABASE_URL:-}" ]] || { echo 'The two-node PostgreSQL profile is required' >&2; exit 2; }
base=(docker --context "$DOCKER_CONTEXT" compose --project-name "$project" -f "$sandbox/compose.yaml" -f "$root/tests/atmosphere/stacks/incoming-source-mail.yaml")
exec 9>"$sandbox/.managed-create-barrier.lock"
flock -n 9 || { echo 'A managed create barrier already owns this sandbox' >&2; exit 1; }
# Verify the actual candidate image, not a bind-mounted host copy.
for file in managed-create-barrier.mjs managed-create-barrier-preload.mjs; do
  expected=$(sha256sum "$root/tests/support/$file" | cut -d' ' -f1)
  actual=$(timeout 30s "${base[@]}" run --rm --no-deps --entrypoint sha256sum entryway "/app/tests/support/$file" | cut -d' ' -f1)
  [[ "$actual" == "$expected" ]] || { echo "Candidate image does not contain the current $file" >&2; exit 1; }
done
umask 077
export MANAGED_CREATE_BARRIER_HOST_DIRECTORY
MANAGED_CREATE_BARRIER_HOST_DIRECTORY=$(mktemp -d "$sandbox/.managed-create-barrier.XXXXXX")
overlay=("${base[@]}" -f "$root/tests/atmosphere/stacks/managed-create-barrier.yaml")
restore=0
driver="${project}-managed-create-barrier-driver-$$"
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if docker --context "$DOCKER_CONTEXT" container inspect "$driver" >/dev/null 2>&1; then
    timeout 30s docker --context "$DOCKER_CONTEXT" rm -f "$driver" >/dev/null || result=1
  fi
  if (( restore )); then
    if ! timeout 120s "${base[@]}" up -d --wait --no-deps --force-recreate entryway; then
      echo 'Failed to restore the primary Entryway node' >&2
      result=1
    fi
  fi
  rm -rf -- "$MANAGED_CREATE_BARRIER_HOST_DIRECTORY" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
restore=1
timeout 120s "${overlay[@]}" up -d --wait --no-deps --force-recreate entryway
# The driver sees only the private marker directory, never the host sandbox.
timeout 180s "${base[@]}" run --rm --no-deps --name "$driver" \
  --volume "$MANAGED_CREATE_BARRIER_HOST_DIRECTORY:/run/managed-create-barrier" \
  -e MANAGED_CREATE_BARRIER_DIRECTORY=/run/managed-create-barrier browser "$@"
