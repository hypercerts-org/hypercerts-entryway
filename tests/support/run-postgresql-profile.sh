#!/usr/bin/env bash
# Own a separate fresh AiaB project; private config/session/backup remain in volumes.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
parent_artifacts=${ACCEPTANCE_REPORT_DIR:-"$root/tests/artifacts"}
run="$(date +%s)-$$"
export SANDBOX_CHECKOUT="$root/tests/.runtime/postgresql-profile-$run"
export SANDBOX_PROJECT="hypercerts-entryway-postgresql-profile-$run"
export ACCEPTANCE_REPORT_DIR="$parent_artifacts/postgresql-profile-$run"
export DATABASE_BACKEND=postgresql DEPLOYMENT_MODE=single-node
export DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority
mkdir -p "$ACCEPTANCE_REPORT_DIR"
source "$root/tests/support/rootless-docker.sh"
printf '%s\n' "$SANDBOX_CHECKOUT" "$SANDBOX_PROJECT" "$ACCEPTANCE_REPORT_DIR" > "$ACCEPTANCE_REPORT_DIR/sandbox-identity.txt"
compose() { docker --context rootless compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" "$@"; }
cleanup() {
  status=$?
  printf '%s\n' "$status" > "$ACCEPTANCE_REPORT_DIR/profile.exit"
  if (( status == 0 )); then compose down --volumes --remove-orphans; else echo "Preserved owned PostgreSQL profile $SANDBOX_PROJECT" >&2; fi
}
trap cleanup EXIT
"$root/tests/local.sh" prepare > "$ACCEPTANCE_REPORT_DIR/prepare.log" 2>&1
"$root/tests/local.sh" up > "$ACCEPTANCE_REPORT_DIR/up.log" 2>&1
probe() { compose run --rm --no-deps test node tests/support/postgresql-profile.mjs "$1" > "$ACCEPTANCE_REPORT_DIR/$1.log" 2>&1; }
probe login
compose restart entryway > "$ACCEPTANCE_REPORT_DIR/restart.log" 2>&1
compose up -d --wait entryway >> "$ACCEPTANCE_REPORT_DIR/restart.log" 2>&1
probe restart
compose stop entryway > "$ACCEPTANCE_REPORT_DIR/restore.log" 2>&1
# Dump and restore execute inside the owned PostgreSQL container. No secret or
# database bytes cross into host reports, and the original database is retained.
compose exec -T entryway-postgres sh -ec 'pg_dump -U authority_owner -Fc -f /backup/authority.dump account_authority; createdb -U authority_owner account_authority_restored; pg_restore -U authority_owner --exit-on-error -d account_authority_restored /backup/authority.dump' >> "$ACCEPTANCE_REPORT_DIR/restore.log" 2>&1
export DATABASE_URL=postgresql://authority_owner@entryway-postgres/account_authority_restored
compose up -d --force-recreate --wait entryway >> "$ACCEPTANCE_REPORT_DIR/restore.log" 2>&1
probe restore
