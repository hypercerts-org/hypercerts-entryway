#!/usr/bin/env bash
set -euo pipefail
root=$1 sandbox=$2 project=$3 context=$4 cutpoint=$5
node "$root/tests/support/incoming-owner-guard.mjs" "$root" "${INCOMING_OWNER_MANIFEST:-}" "$project" "$sandbox" "$context" state || exit 75
node "$root/tests/support/incoming-compose-guard.mjs" "$context" "$project" "$sandbox" "$root" || exit 75
case "$cutpoint" in
  before) marker=/run/incoming-barrier; selector=INCOMING_BEFORE_SIGNED_SUBMIT; grep_pattern="a public incoming migration keeps the source DID" ;;
  after) marker=/run/incoming-after-publication; selector=INCOMING_AFTER_SIGNED_PUBLICATION; grep_pattern="staged signed publication survives a lost client response and restart" ;;
  *) echo "Invalid cutpoint" >&2; exit 2 ;;
esac
compose() { docker --context "$context" compose --project-name "$project" -f "$sandbox/compose.yaml" -f "$root/tests/atmosphere/stacks/incoming-source-mail.yaml" "$@"; }
barrier=$(mktemp -d "$sandbox/.incoming-barrier.XXXXXX")
chmod 777 "$barrier"
pid=
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf -- "$barrier"
}
trap cleanup EXIT
# The browser and running Entryway must contain the frozen candidate's source.
cp -- "$INCOMING_SOURCE_FILES" "$barrier/files"
(cd "$root" && xargs -d '\n' sha256sum < "$barrier/files") > "$barrier/expected"
docker --context "$context" run --rm -i --entrypoint sh "$project-browser:local" -c 'cd /app && xargs -d "\n" sha256sum' < "$barrier/files" > "$barrier/browser"
docker --context "$context" exec -i "${project}-entryway-1" sh -c 'cd /app && xargs -d "\n" sha256sum' < "$barrier/files" > "$barrier/entryway"
cmp "$barrier/expected" "$barrier/browser"
cmp "$barrier/expected" "$barrier/entryway"
echo 'candidate-source-parity=verified'
pds_image=$(docker --context "$context" image inspect "$project-late-cutover-pds:local" --format '{{.Id}}')
[[ "$(docker --context "$context" inspect "${project}-pds1-1" --format '{{.Image}}')" == "$pds_image" ]] || { echo 'staged PDS image mismatch' >&2; exit 1; }
printf 'staged-pds-image=%s pinned-revision=9c31da3d73bbc35ca1b1e32d1fd488acfd754c61\n' "$pds_image"
compose run --rm --no-deps --volume "$sandbox/incoming-access.json:/run/incoming-access.json:ro" \
  --volume "$barrier:$marker" -e INCOMING_ACCESS_PATH=/run/incoming-access.json \
  -e "INCOMING_PROJECT=$project" -e INCOMING_LATE_CUTOVER=1 -e "$selector=1" \
  browser npx --no-install playwright test --config tests/playwright.config.mjs \
  --project=cutover-at-entryway --grep "$grep_pattern" &
pid=$!
for attempt in {1..300}; do
  [[ -f "$barrier/ready" ]] && break
  kill -0 "$pid" 2>/dev/null || { wait "$pid"; echo 'browser exited before barrier' >&2; exit 1; }
  sleep 1
done
[[ -f "$barrier/ready" ]] || { echo 'signed-submit barrier timeout' >&2; exit 1; }
id=$(compose ps --quiet entryway)
[[ -n "$id" && "$id" != *$'\n'* ]] || exit 1
before=$(docker --context "$context" inspect --format '{{.Image}} {{.State.StartedAt}}' "$id")
node "$root/tests/support/incoming-owner-guard.mjs" "$root" "$INCOMING_OWNER_MANIFEST" "$project" "$sandbox" "$context" state || exit 75
node "$root/tests/support/incoming-compose-guard.mjs" "$context" "$project" "$sandbox" "$root" || exit 75
compose restart entryway
[[ "$(compose ps --quiet entryway)" == "$id" ]] || { echo 'container recreated' >&2; exit 1; }
after=$(docker --context "$context" inspect --format '{{.Image}} {{.State.StartedAt}}' "$id")
[[ "${before%% *}" == "${after%% *}" && "${before#* }" != "${after#* }" ]] || { echo 'restart not observed' >&2; exit 1; }
for attempt in {1..60}; do
  [[ "$(docker --context "$context" inspect --format '{{.State.Health.Status}}' "$id")" == healthy ]] && break
  sleep 2
done
[[ "$(docker --context "$context" inspect --format '{{.State.Health.Status}}' "$id")" == healthy ]] || { echo 'entryway not ready' >&2; exit 1; }
echo 'entryway-restart=same-container-same-image-new-start-healthy'
touch "$barrier/release"
wait "$pid"
pid=
