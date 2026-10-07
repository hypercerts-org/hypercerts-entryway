#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
export ACCEPTANCE_REPORT_DIR="${ACCEPTANCE_REPORT_DIR:-$root/tests/artifacts}/resilience-profiles-$(date +%s)-$$"
export PROFILE_COLLECTION_INDEX="$ACCEPTANCE_REPORT_DIR/profiles.tsv"
export KEEP_PROFILE_SANDBOX=1
mkdir -p "$ACCEPTANCE_REPORT_DIR"
source "$root/tests/support/rootless-docker.sh"
for profile in sqlite-single-node postgresql-single-node postgresql-multi-node; do
  bash "$root/tests/support/run-resilience-profile.sh" "$profile"
done
last=$(tail -1 "$PROFILE_COLLECTION_INDEX" | cut -f2)
mapfile -t identity < "$ACCEPTANCE_REPORT_DIR/$last/sandbox-identity.txt"
result=0
printf '%q ' env "SANDBOX_PROJECT=${identity[1]}" docker --context rootless compose --project-name "${identity[1]}" -f "${identity[0]}/compose.yaml" run --rm --no-deps -v "$ACCEPTANCE_REPORT_DIR:/profiles:ro" -v "$ACCEPTANCE_REPORT_DIR:/app/artifacts:z" test node tests/support/assert-resilience-profiles.mjs > "$ACCEPTANCE_REPORT_DIR/assert-all.command"
printf '\n' >> "$ACCEPTANCE_REPORT_DIR/assert-all.command"
SANDBOX_PROJECT="${identity[1]}" docker --context rootless compose --project-name "${identity[1]}" -f "${identity[0]}/compose.yaml" run --rm --no-deps -v "$ACCEPTANCE_REPORT_DIR:/profiles:ro" -v "$ACCEPTANCE_REPORT_DIR:/app/artifacts:z" test node tests/support/assert-resilience-profiles.mjs > "$ACCEPTANCE_REPORT_DIR/assert-all.log" 2>&1 || result=$?
printf '%s\n' "$result" > "$ACCEPTANCE_REPORT_DIR/assert-all.exit"
cat "$ACCEPTANCE_REPORT_DIR/assert-all.log"
(( result == 0 )) || exit "$result"
while IFS=$'\t' read -r profile directory; do
  mapfile -t identity < "$ACCEPTANCE_REPORT_DIR/$directory/sandbox-identity.txt"
  SANDBOX_PROJECT="${identity[1]}" docker --context rootless compose --project-name "${identity[1]}" -f "${identity[0]}/compose.yaml" down --volumes --remove-orphans
done < "$PROFILE_COLLECTION_INDEX"
