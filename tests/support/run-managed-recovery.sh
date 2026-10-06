#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/operational-common.sh"
run_id="$(date -u +%Y%m%dt%H%M%Sz)"
name=${project}-managed-recovery
active=false
record_candidate managed-recovery
health() {
  for i in {1..60}; do
    if compose exec -T pds1 node -e 'fetch("https://entryway.atmosbox.test/_health",{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  return 1
}
finish() {
  local code=$?
  trap - EXIT INT TERM
  remove_owned "${project}-managed-recovery-browser" || code=1
  if $active; then
    remove_owned "$name" || code=1
    compose start entryway >/dev/null || code=1
    health || code=1
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
active=true
compose stop --timeout 10 entryway >/dev/null
for mode in consumed-success rejected-request; do
  run="$run_id-$mode"
  compose run -d --no-deps --use-aliases --name "$name" -e MANAGED_RECOVERY_RUN="$run" -e MANAGED_RECOVERY_MODE="$mode" \
    entryway node --import ./tests/support/managed-migration-checkpoint.mjs dist/src/main.mjs >/dev/null
  health
  compose run --rm --no-deps --name "${project}-managed-recovery-browser" -e MANAGED_RECOVERY_RUN="$run" -e MANAGED_RECOVERY_MODE="$mode" \
    browser npx --no-install playwright test migration-console.spec.mjs --config tests/operational.playwright.config.mjs \
    > "$artifacts/managed-recovery-$run.log" 2>&1
  cp "$artifacts/managed-recovery-$run-result.json" "$artifacts/managed-recovery-$mode.json"
  remove_owned "$name"
done
node --input-type=module - "$artifacts" "$run_id" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const [directory,run]=process.argv.slice(2);
const modes=['consumed-success','rejected-request'];
const results=modes.map(mode=>({mode,...JSON.parse(readFileSync(`${directory}/managed-recovery-${mode}.json`))}));
if(results.some(result=>result.status!=='passed')) throw Error('IncompleteManagedRecovery');
writeFileSync(`${directory}/managed-recovery.json`,JSON.stringify({status:'passed',run,results}));
JS
echo 'PASS both managed migration recovery modes: consumed success and rejected-request observe-to-retry upgrade'
