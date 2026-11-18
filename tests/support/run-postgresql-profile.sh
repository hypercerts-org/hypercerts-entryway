#!/usr/bin/env bash
# Own a separate fresh AiaB project; private config/session/backup remain in volumes.
# With POSTGRESQL_PROFILE_REUSE_SANDBOX=1 (CI databases job) run in the caller's
# already prepared sandbox instead: nothing is prepared, registered or torn down
# here, so the caller must own cleanup. Set it only with SANDBOX_CHECKOUT and
# SANDBOX_PROJECT of that sandbox.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
parent_artifacts=${ACCEPTANCE_REPORT_DIR:-"$root/tests/artifacts"}
run="$(date +%s)-$$"
reuse_sandbox=${POSTGRESQL_PROFILE_REUSE_SANDBOX:-0}
if [[ "$reuse_sandbox" == 1 ]]; then
  : "${SANDBOX_CHECKOUT:?POSTGRESQL_PROFILE_REUSE_SANDBOX=1 needs the SANDBOX_CHECKOUT of a prepared sandbox}" "${SANDBOX_PROJECT:?POSTGRESQL_PROFILE_REUSE_SANDBOX=1 needs the SANDBOX_PROJECT of a prepared sandbox}"
  [[ -f "$SANDBOX_CHECKOUT/compose.yaml" ]] || { echo "POSTGRESQL_PROFILE_REUSE_SANDBOX=1 found no $SANDBOX_CHECKOUT/compose.yaml; run tests/local.sh prepare and up first, or unset it for a standalone profile" >&2; exit 2; }
else
  export SANDBOX_CHECKOUT="$root/tests/.runtime/postgresql-profile-$run"
  export SANDBOX_PROJECT="hypercerts-entryway-postgresql-profile-$run"
fi
export ACCEPTANCE_REPORT_DIR="$parent_artifacts/postgresql-profile-$run"
export DATABASE_BACKEND=postgresql DEPLOYMENT_MODE=single-node
export DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority
mkdir -p "$ACCEPTANCE_REPORT_DIR"
if [[ "$reuse_sandbox" != 1 && -n "${CI_OWNERSHIP_MANIFEST:-}" ]]; then
  python3 "$root/scripts/ci-ownership.py" register "$CI_OWNERSHIP_MANIFEST" "$SANDBOX_CHECKOUT" "$SANDBOX_PROJECT"
fi
source "$root/tests/support/rootless-docker.sh"
printf '%s\n' "$SANDBOX_CHECKOUT" "$SANDBOX_PROJECT" "$ACCEPTANCE_REPORT_DIR" > "$ACCEPTANCE_REPORT_DIR/sandbox-identity.txt"
compose() { docker --context "$DOCKER_CONTEXT" compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" "$@"; }
cleanup() {
  status=$?
  printf '%s\n' "$status" > "$ACCEPTANCE_REPORT_DIR/profile.exit"
  if [[ "$reuse_sandbox" == 1 ]]; then echo "Left reused sandbox $SANDBOX_PROJECT to its owner" >&2
  elif (( status == 0 )); then compose down --volumes --remove-orphans; else echo "Preserved owned PostgreSQL profile $SANDBOX_PROJECT" >&2; fi
}
trap cleanup EXIT
if [[ "$reuse_sandbox" == 1 ]]; then
  # No-op when the sandbox already runs on PostgreSQL; otherwise recreates only
  # entryway against it. A stale SQLite file from a default start is then
  # reported by the profile's no-SQLite-fallback check.
  compose up -d --wait entryway-postgres entryway 2>&1 | tee "$ACCEPTANCE_REPORT_DIR/up.log"
else
  "$root/tests/local.sh" prepare 2>&1 | tee "$ACCEPTANCE_REPORT_DIR/prepare.log"
  "$root/tests/local.sh" up 2>&1 | tee "$ACCEPTANCE_REPORT_DIR/up.log"
fi
probe() {
  local phase="$1"
  echo "PostgreSQL profile: $phase"
  local result=0
  local tee_options=()
  if [[ "$phase" == restart || "$phase" == restore ]]; then tee_options=(-a); fi
  compose run --rm --no-deps test node tests/support/postgresql-profile.mjs "$phase" 2>&1 | tee "${tee_options[@]}" "$ACCEPTANCE_REPORT_DIR/$phase.log" | python3 "$root/scripts/ci-summary.py" || result=$?
  printf 'profile=postgresql phase=%s status=finished exit=%s\n' "$phase" "$result"
  return "$result"
}
probe login
compose restart entryway 2>&1 | tee "$ACCEPTANCE_REPORT_DIR/restart.log"
compose up -d --wait entryway 2>&1 | tee -a "$ACCEPTANCE_REPORT_DIR/restart.log"
probe restart
compose stop entryway 2>&1 | tee "$ACCEPTANCE_REPORT_DIR/restore.log"
# Dump and restore execute inside the owned PostgreSQL container. No secret or
# database bytes cross into host reports, and the original database is retained.
compose exec -T entryway-postgres sh -ec 'pg_dump -U authority_owner -Fc -f /backup/authority.dump account_authority; createdb -U authority_owner account_authority_restored; pg_restore -U authority_owner --exit-on-error -d account_authority_restored /backup/authority.dump' 2>&1 | tee -a "$ACCEPTANCE_REPORT_DIR/restore.log"
export DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority_restored
compose up -d --force-recreate --wait entryway 2>&1 | tee -a "$ACCEPTANCE_REPORT_DIR/restore.log"
probe restore
