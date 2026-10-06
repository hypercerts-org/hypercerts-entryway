#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/operational-common.sh"
OPERATIONAL_COMMAND_TIMEOUT_SECONDS=420
name=${project}-crash
active=false
browser_pid=''
record_candidate process-crash
finish() {
  local code=$?
  trap - EXIT INT TERM
  remove_owned "${project}-operational-browser" || code=1
  if $active; then
    remove_owned "$name" || code=1
    compose start entryway >/dev/null || code=1
    health || code=1
  fi
  if [[ -n "$browser_pid" ]]; then wait "$browser_pid" || code=1; fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
health() {
  for i in {1..60}; do
    if compose exec -T pds1 node -e 'fetch("https://entryway.atmosbox.test/_health",{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  return 1
}
filewait() {
  for i in {1..100}; do [[ -f $1 ]] && return; sleep 1; done
  echo "Checkpoint missing: $1" >&2; return 1
}
for mode in before-pds after-pds; do
  run="$(date -u +%Y%m%dt%H%M%Sz)-$mode"
  prefix="$artifacts/crash-$run"
  active=true
  compose stop --timeout 10 entryway >/dev/null
  compose run -d --no-deps --use-aliases --name "$name" \
    -e CRASH_PROBE_RUN="$run" -e CRASH_PROBE_MODE="$mode" \
    entryway node --import ./tests/support/crash-checkpoint.mjs dist/src/main.mjs >/dev/null
  health
  compose run --rm --no-deps --name "${project}-operational-browser" -e CRASH_PROBE_RUN="$run" -e CRASH_PROBE_MODE="$mode" \
    browser npx --no-install playwright test process-crash.spec.mjs --config tests/operational.playwright.config.mjs \
    > "$artifacts/crash-$mode.log" 2>&1 &
  browser_pid=$!
  filewait "$prefix-observed.json"
  docker --context rootless kill --signal KILL "$name" >/dev/null
  docker --context rootless inspect --format '{{.State.ExitCode}}' "$name" > "$artifacts/crash-$mode-exit.txt"
  [[ $(cat "$artifacts/crash-$mode-exit.txt") == 137 ]]
  dispatcher_id=$(docker --context rootless inspect --format '{{.Id}}' "$name")
  remove_owned "$name"
  # The old Entryway container cannot send again. Stop the affected unchanged PDS
  # before restart, proving no prior handler can continue after acknowledgement.
  compose stop --timeout 10 pds1 > "$artifacts/crash-$mode-pds-drain.log" 2>&1
  upstream_id=$(compose ps -a -q pds1)
  [[ $(docker --context rootless inspect --format '{{.State.Running}}' "$upstream_id") == false ]]
  compose start pds1 >> "$artifacts/crash-$mode-pds-drain.log" 2>&1
  compose exec -T pds1 node --input-type=module -e 'for(let i=0;i<120;i++){try{if((await fetch("http://localhost:3000/xrpc/_health")).ok)process.exit(0)}catch{};await new Promise(r=>setTimeout(r,250))};process.exit(1)'
  compose start entryway >/dev/null
  health
  compose exec -T entryway node --input-type=module -e 'import{writeFileSync}from"node:fs";writeFileSync(process.argv[1], "")' "/app/artifacts/crash-$run-restarted"
  filewait "$prefix-pending-ui.json"
  compose exec -T entryway node --input-type=module -e 'import{writeFileSync}from"node:fs";const [run,dispatcherId,upstreamId]=process.argv.slice(1);writeFileSync(`/app/artifacts/crash-${run}-isolation.json`,JSON.stringify({run,dispatcherId,dispatcherExit:137,dispatcherRemoved:true,upstreamId,upstreamStopped:true,upstreamRestarted:true,at:new Date().toISOString()}))' "$run" "$dispatcher_id" "$upstream_id"
  compose exec -T entryway node tests/support/recover-crash-operation.mjs "$run" > "$artifacts/crash-$mode-recovery.log" 2>&1
  wait "$browser_pid"
  browser_pid=''
  cp "$prefix-result.json" "$artifacts/crash-$mode.json"
  echo "PASS $mode (SIGKILL exit 137, durable pending, verified recovery and browser/PDS proof)"
  active=false
done
