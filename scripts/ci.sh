#!/usr/bin/env bash
# Contributors and CI use the same owned lifecycle; raw reports stay private.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
mode=${1:-}
case "$mode" in checks|integration|databases|profiles|cleanup) ;; *) echo 'Usage: scripts/ci.sh checks|integration|databases|profiles|cleanup' >&2; exit 2 ;; esac
export CI_OWNERSHIP_MANIFEST=${CI_OWNERSHIP_MANIFEST:-"$root/tests/artifacts/ci-$mode-$(date +%s)-$$/ownership.json"}
source "$root/tests/support/rootless-docker.sh"
if [[ "$mode" == cleanup ]]; then
  test ! -f "$CI_OWNERSHIP_MANIFEST" || python3 "$root/scripts/ci-ownership.py" cleanup "$CI_OWNERSHIP_MANIFEST"
  exit 0
fi
python3 "$root/scripts/ci-ownership.py" init "$CI_OWNERSHIP_MANIFEST"
run="$(date +%s)-$$"
export SANDBOX_PROJECT="hypercerts-entryway-ci-$mode-$run"
export SANDBOX_CHECKOUT="$root/tests/.runtime/ci-$mode-$run"
export ACCEPTANCE_REPORT_DIR="$(dirname "$CI_OWNERSHIP_MANIFEST")/reports"
export SOURCE_CHECKOUT="$root"
mkdir -p "$SANDBOX_CHECKOUT" "$ACCEPTANCE_REPORT_DIR"
python3 "$root/scripts/ci-ownership.py" register "$CI_OWNERSHIP_MANIFEST" "$SANDBOX_CHECKOUT" "$SANDBOX_PROJECT"
cleanup() {
  local result=$? cleanup_status=0
  trap - EXIT INT TERM
  python3 "$root/scripts/ci-ownership.py" cleanup "$CI_OWNERSHIP_MANIFEST" > "$ACCEPTANCE_REPORT_DIR/cleanup.log" 2>&1 || cleanup_status=$?
  printf 'mode=%s exit=%s cleanup=%s\n' "$mode" "$result" "$cleanup_status" | tee "$(dirname "$CI_OWNERSHIP_MANIFEST")/summary.txt"
  if (( result == 0 && cleanup_status != 0 )); then result=$cleanup_status; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
case "$mode" in
  checks)
    "$root/tests/atmosphere/prepare.sh"
    cp "$root/tests/atmosphere/ci-tooling.yaml" "$SANDBOX_CHECKOUT/compose.yaml"
    compose=(docker --context rootless compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml")
    "${compose[@]}" build checks
    "${compose[@]}" run --rm --no-deps checks
    ;;
  integration) "$root/tests/local.sh" all > "$ACCEPTANCE_REPORT_DIR/integration.log" 2>&1 ;;
  databases)
    { "$root/tests/local.sh" prepare
      "$root/tests/local.sh" up
      "$root/tests/local.sh" database-contracts
    } > "$ACCEPTANCE_REPORT_DIR/databases.log" 2>&1
    ;;
  profiles) "$root/tests/local.sh" resilience-profiles > "$ACCEPTANCE_REPORT_DIR/profiles.log" 2>&1 ;;
esac
