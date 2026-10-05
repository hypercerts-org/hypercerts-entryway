#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/operational-common.sh"
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
  docker kill --signal KILL "$name" >/dev/null
  docker inspect --format '{{.State.ExitCode}}' "$name" > "$artifacts/crash-$mode-exit.txt"
  [[ $(cat "$artifacts/crash-$mode-exit.txt") == 137 ]]
  remove_owned "$name"
  compose start entryway >/dev/null
  health
  compose exec -T entryway node --input-type=module -e 'import{writeFileSync}from"node:fs";writeFileSync(process.argv[1], "")' "/app/artifacts/crash-$run-restarted"
  wait "$browser_pid"
  browser_pid=''
  cp "$prefix-result.json" "$artifacts/crash-$mode.json"
  echo "PASS $mode (SIGKILL exit 137, automatic recovery and browser/PDS proof)"
  active=false
done
