#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/operational-common.sh"
run=$(date -u +%Y%m%dt%H%M%Sz)
out="$artifacts/authority-$run"
mkdir -p "$out"
name=${project}-restored
restored=false
rotated=false
record_candidate authority-drills
configcmd() { compose run --rm --no-deps configure node tests/support/operational-state-probe.mjs "$1" "$run"; }
finish() {
  local code=$?
  trap - EXIT INT TERM
  remove_owned "${project}-operational-browser" || code=1
  if $restored; then
    remove_owned "$name" || code=1
    compose start entryway >/dev/null || code=1
  fi
  if $rotated; then
    configcmd restore-key || code=1
    compose restart entryway pds1 pds2 >/dev/null || code=1
  fi
  health || code=1
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
health() {
  for i in {1..60}; do
    if compose exec -T pds1 node --input-type=module -e 'const urls=["https://entryway.atmosbox.test/_health","https://cluster1.atmosbox.test/xrpc/_health","https://cluster2.atmosbox.test/xrpc/_health"];try{for(const u of urls){if(!(await fetch(u,{signal:AbortSignal.timeout(2000)})).ok)process.exit(1)}}catch{process.exit(1)}' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  return 1
}
probe() {
  compose run --rm --no-deps test node tests/support/operational-state-probe.mjs tokens "$run" "$1"
  cp "$artifacts/operations-$run-rotation-$1.json" "$out/rotation-$1.json"
}
compose run --rm --no-deps --name "${project}-operational-browser" -e OPERATIONAL_RUN="$run" browser npx --no-install playwright test operational-fixture.spec.mjs --config tests/operational.playwright.config.mjs > "$out/fixture.log" 2>&1
compose exec -T entryway node tests/support/operational-state-probe.mjs backup "$run"
cp "$artifacts/operations-$run-backup.json" "$out/backup.json"
restored=true
compose stop --timeout 10 entryway >/dev/null
compose run -d --no-deps --use-aliases --name "$name" \
  -e SPIKE_DATA="/data/verification-$run/restored" \
  -e SPIKE_CONFIG="/data/verification-$run/config.json" entryway node dist/src/main.mjs >/dev/null
health
compose run --rm --no-deps --name "${project}-operational-browser" -e OPERATIONAL_RUN="$run" browser npx --no-install playwright test restored-backup.spec.mjs --config tests/operational.playwright.config.mjs > "$out/restored-browser.log" 2>&1
cp "$artifacts/operations-$run-restored-browser.json" "$out/restored-browser.json"
remove_owned "$name"
compose start entryway >/dev/null
restored=false
health
probe before
# Only the JWT issuer/verification key changes. PLC authority stays identical.
rotated=true
configcmd rotate
compose restart entryway >/dev/null
health
probe issuer-only
compose restart pds1 pds2 >/dev/null
health
probe fleet
compose run --rm --no-deps --name "${project}-operational-browser" -e OPERATIONAL_RUN="$run" -e ROTATION_STAGE=fleet browser npx --no-install playwright test rotation-browser.spec.mjs --config tests/operational.playwright.config.mjs > "$out/rotation-oauth-fleet.log" 2>&1
cp "$artifacts/operations-$run-oauth-fleet.json" "$out/rotation-oauth-fleet.json"
configcmd restore-key
compose restart entryway pds1 pds2 >/dev/null
health
probe restored
compose run --rm --no-deps --name "${project}-operational-browser" -e OPERATIONAL_RUN="$run" -e ROTATION_STAGE=restored browser npx --no-install playwright test rotation-browser.spec.mjs --config tests/operational.playwright.config.mjs > "$out/rotation-oauth-restored.log" 2>&1
cp "$artifacts/operations-$run-oauth-restored.json" "$out/rotation-oauth-restored.json"
rotated=false
echo "PASS backup restore, issuer-only skew, coordinated fleet rotation, and original-key restoration ($run)"
