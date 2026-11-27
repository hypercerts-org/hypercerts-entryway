#!/usr/bin/env bash
# Run only against a disposable staged AiaB project.
set -euo pipefail
root=$1 sandbox=$2 project=$3 mode=$4
: "${DOCKER_CONTEXT:?}"
exec 9<"$sandbox"
flock -n 9 || { echo "Controller launch already running for this sandbox" >&2; exit 2; }
helper="$root/tests/support/controller-launch.mjs"
private="$sandbox/.controller-launch"
reset_destination() {
  docker --context "$DOCKER_CONTEXT" compose --project-name "$project" -f "$sandbox/compose.yaml" up -d --no-deps --force-recreate --wait pds1 >/dev/null
}
cleanup() {
  status=$?
  trap - EXIT
  if ! node "$helper" cleanup "$project" "$sandbox"; then
    echo 'Controller launch cleanup failed. Retry controller-launch cleanup for this sandbox.' >&2
    status=1
  fi
  exit "$status"
}
node "$helper" cleanup "$project" "$sandbox"
if [[ "$mode" == cleanup ]]; then exit 0; fi
trap cleanup EXIT
node "$helper" probe "$project" "$sandbox"
node "$helper" cleanup "$project" "$sandbox"
node "$helper" launch "$project" "$sandbox"
node "$helper" verify "$project" "$sandbox"
input=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).inputVolume' "$private/state.json")
image=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).toolImage' "$private/state.json")
mutate() {
  docker --context "$DOCKER_CONTEXT" run --rm --network none --user 0:0 --mount "type=volume,src=$input,dst=/sealed" --entrypoint node "$image" -e 'const fs=require("node:fs");const n=fs.readdirSync("/sealed").filter(x=>x.startsWith(process.argv[1]+"-")&&!x.endsWith(".sig"));if(n.length!==1)process.exit(1);const p="/sealed/"+n[0];fs.chmodSync(p,0o600);if(process.argv[2]==="append")fs.appendFileSync(p,"\n");else fs.truncateSync(p,fs.statSync(p).size-1);fs.chmodSync(p,0o400)' "$1" "$2"
}
for kind in launcher config; do
  mutate "$kind" append
  if node "$helper" verify "$project" "$sandbox" >/dev/null 2>&1; then echo 'Changed launch snapshot was accepted' >&2; exit 1; fi
  mutate "$kind" restore
  node "$helper" verify "$project" "$sandbox" >/dev/null
done
origin=$(docker --context "$DOCKER_CONTEXT" ps --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=pds1' --format '{{.ID}}')
docker --context "$DOCKER_CONTEXT" restart "$origin" >/dev/null
if node "$helper" verify "$project" "$sandbox" >/dev/null 2>&1; then echo 'Restarted destination was accepted' >&2; exit 1; fi
mv -- "$private" "${private}-retired"
reset_destination
node "$helper" launch "$project" "$sandbox" >/dev/null
node "$helper" verify "$project" "$sandbox" >/dev/null
docker --context "$DOCKER_CONTEXT" compose --project-name "$project" -f "$sandbox/compose.yaml" -f "$private/compose.json" up -d --no-deps --force-recreate --wait pds1 >/dev/null
if node "$helper" verify "$project" "$sandbox" >/dev/null 2>&1; then echo 'Replaced destination was accepted' >&2; exit 1; fi
echo 'Controller launch: owned snapshots and stale/restart/replacement refusal passed'
