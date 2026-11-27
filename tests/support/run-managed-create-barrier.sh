#!/usr/bin/env bash
# Run one test driver with a barrier on the primary node of an owned sandbox.
set -euo pipefail
root=$1 sandbox=$2 project=$3
shift 3
(( $# > 0 )) || { echo 'A browser-container test driver command is required' >&2; exit 2; }
[[ "$project" != hypercerts-entryway ]] || { echo 'A disposable project is required' >&2; exit 2; }
[[ "${DATABASE_BACKEND:-}" == postgresql && "${DEPLOYMENT_MODE:-}" == multi-node && "${ENTRYWAY_PROFILE_NODE_COUNT:-}" == 2 && -n "${DATABASE_URL:-}" ]] || { echo 'The two-node PostgreSQL profile is required' >&2; exit 2; }
[[ -n "${DOCKER_CONTEXT:-}" ]] || { echo 'Verified DOCKER_CONTEXT is required' >&2; exit 2; }
base=(docker --context "$DOCKER_CONTEXT" compose --project-name "$project" -f "$sandbox/compose.yaml" -f "$root/tests/atmosphere/stacks/incoming-source-mail.yaml")
exec 9>"$sandbox/.managed-create-barrier.lock"
flock -n 9 || { echo 'A managed create barrier already owns this sandbox' >&2; exit 1; }
# Verify every staged candidate file in both images, not a host bind mount.
for service in entryway browser; do
  for file in docs/testing.md tests/browser/cross-entry-managed-first.spec.mjs tests/local.sh tests/playwright.config.mjs tests/support/run-managed-create-barrier.sh tests/support/managed-create-barrier.mjs tests/support/managed-create-barrier-preload.mjs; do
    expected=$(sha256sum "$root/$file" | cut -d' ' -f1)
    actual=$(timeout 30s "${base[@]}" run --rm --no-deps --entrypoint sha256sum "$service" "/app/$file" | cut -d' ' -f1)
    [[ "$actual" == "$expected" ]] || { echo "Candidate image mismatch: $service $file" >&2; exit 1; }
  done
  echo "Candidate files verified in $service image"
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
  # Compose --rm and forced removal can race. Inspect the exact name through
  # the daemon until auto-removal settles; a daemon error is not absence.
  timeout 30s docker --context "$DOCKER_CONTEXT" rm -f "$driver" >/dev/null 2>&1 || true
  local remaining deadline=$((SECONDS + 10))
  while :; do
    if ! remaining=$(timeout 5s docker --context "$DOCKER_CONTEXT" ps --all --filter "name=^/${driver}$" --format '{{.Names}}'); then
      echo 'Failed to check driver removal via Docker daemon' >&2
      (( result != 0 )) || result=1
      break
    fi
    [[ -z "$remaining" ]] && break
    if (( SECONDS >= deadline )); then
      echo 'Driver container survived bounded cleanup' >&2
      (( result != 0 )) || result=1
      break
    fi
    sleep 0.2
  done
  if (( restore )); then
    if ! timeout 120s "${base[@]}" up -d --wait --no-deps --force-recreate entryway; then
      echo 'Failed to restore the primary Entryway node' >&2
      (( result != 0 )) || result=1
    fi
  fi
  rm -rf -- "$MANAGED_CREATE_BARRIER_HOST_DIRECTORY" || { (( result != 0 )) || result=1; }
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
restore=1
timeout 120s "${overlay[@]}" up -d --wait --no-deps --force-recreate entryway
# The driver receives the marker directory and, when present, the allowlisted access projection.
access_mount=()
if [[ -f "$sandbox/incoming-access.json" ]]; then
  access_mount=(--volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro")
fi
timeout 240s "${base[@]}" run --rm --no-deps --name "$driver" \
  "${access_mount[@]}" --volume "$MANAGED_CREATE_BARRIER_HOST_DIRECTORY:/run/managed-create-barrier" \
  -e MANAGED_CREATE_BARRIER_DIRECTORY=/run/managed-create-barrier browser "$@"
