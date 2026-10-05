#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/operational-common.sh"
run_id="$(date -u +%Y%m%dt%H%M%Sz)"
report_dir="$artifacts/plc-recovery-$run_id"
mkdir -p "$report_dir"
record_candidate plc-recovery
disrupted=false
child=''
restore() {
  if [[ "$disrupted" == true ]]; then
    compose start plc > "$report_dir/restore.log" 2>&1
    compose exec -T entryway node --input-type=module -e '
      for(let i=0;i<120;i++) {
        try { if ((await fetch("https://plc.atmosbox.test/_health",{signal:AbortSignal.timeout(2000)})).ok) process.exit(0) } catch {}
        await new Promise(r=>setTimeout(r,250))
      }
      process.exit(1)
    '
    disrupted=false
  fi
}
finish() {
  local code=$?
  trap - EXIT INT TERM
  restore || code=1
  if [[ -n "$child" ]]; then
    # Unblock this run's probe after restoring PLC so its scoped cleanup can finish.
    compose exec -T entryway node -e 'const fs=require("fs");for(const s of ["continue","restored"])fs.writeFileSync(`/app/artifacts/plc-recovery-${process.argv[1]}-${s}`,"")' "$run" >/dev/null || true
    wait "$child" || code=1
    remove_owned "${project}-plc-probe" || code=1
  fi
  echo "PLC recovery evidence: $report_dir"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT TERM
wait_file() {
  local suffix=$1
  for ((i=0; i<240; i++)); do
    if compose exec -T entryway test -f "/app/artifacts/plc-recovery-$run-$suffix"; then return; fi
    kill -0 "$child" 2>/dev/null || { echo 'Probe stopped before checkpoint' >&2; return 1; }
    sleep 0.25
  done
  echo 'Probe checkpoint timed out' >&2
  return 1
}
signal_file() {
  compose exec -T entryway node -e 'require("fs").writeFileSync(`/app/artifacts/plc-recovery-${process.argv[1]}-${process.argv[2]}`,"")' "$run" "$1"
}
for mode in lost-response plc-outage restart-outage cache-miss-outage plc-outage-before-create; do
  run="$run_id-$mode"
  compose run --rm --no-deps --name "${project}-plc-probe" test node tests/support/plc-recovery-probe.mjs "$mode" "$run" > "$report_dir/$mode.log" 2>&1 &
  child=$!
  if [[ "$mode" != lost-response ]]; then
    wait_file ready.json
    disrupted=true
    compose stop --timeout 10 plc > "$report_dir/$mode-stop.log" 2>&1
    if [[ "$mode" == restart-outage ]]; then
      compose restart pds1 > "$report_dir/pds-restart.log" 2>&1
      compose exec -T pds1 node --input-type=module -e 'for(let i=0;i<100;i++){try{if((await fetch("http://localhost:3000/xrpc/_health")).ok)process.exit(0)}catch{};await new Promise(r=>setTimeout(r,200))};process.exit(1)'
    elif [[ "$mode" == cache-miss-outage ]]; then
      did=$(compose exec -T entryway node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(`/app/artifacts/plc-recovery-${process.argv[1]}-ready.json`)).did)' "$run")
      # Only this newly-created synthetic DID's regenerable cache entry is removed.
      compose exec -T pds1 node -e 'const assert=require("assert/strict");const {DatabaseSync}=require("node:sqlite");const did=process.argv[1];assert.match(did,/^did:plc:[a-z2-7]{24}$/);const db=new DatabaseSync("/data/did_cache.sqlite");const row=db.prepare("SELECT doc FROM did_doc WHERE did=?").get(did);assert.ok(JSON.parse(row.doc).alsoKnownAs.some(v=>/^at:\/\/plc-[0-9a-f]{10}\./.test(v)));const result=db.prepare("DELETE FROM did_doc WHERE did=?").run(did);assert.equal(result.changes,1);db.close();console.log("Removed only the probe DID cache entry")' "$did" > "$report_dir/cache-fault.log" 2>&1
    fi
    signal_file continue
    wait_file observed.json
    restore
    signal_file restored
  fi
  wait "$child"
  child=''
  compose exec -T entryway cat "/app/artifacts/plc-recovery-$run-result.json" > "$report_dir/$mode.json"
  echo "PASS $mode"
done
