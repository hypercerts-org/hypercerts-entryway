#!/usr/bin/env bash
# Run only against a disposable staged AiaB project.
set -euo pipefail
root=$1 sandbox=$2 project=$3 mode=$4
: "${DOCKER_CONTEXT:?}"
exec 9<"$sandbox"
flock -n 9 || { echo 'Controller gateway already running for this sandbox' >&2; exit 2; }
helper="$root/tests/support/controller-launch.mjs"
private="$sandbox/.controller-gateway"
launch="$sandbox/.controller-launch"
network="${project}-controller-private-test"
sidecar="${project}-controller-gateway-test"
tunnel="${project}-controller-tunnel-test"
key_volume="${project}-controller-gateway-key-test"
replacement="${project}-controller-gateway-replacement"
replacement_key="${project}-controller-gateway-key-replacement"
cert="$sandbox/state/ca/controller-gateway-test.crt"
caddyfile="$sandbox/state/Caddyfile"
caddy="${project}-gateway-1"
dns="${project}-dns-1"
for pair in "$caddy:gateway" "$dns:dns"; do
  container=${pair%:*}; service=${pair#*:}
  labels=$(docker --context "$DOCKER_CONTEXT" container inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}' "$container")
  [[ "$labels" == "$project $service" ]] || { echo 'Sandbox service identity mismatch' >&2; exit 1; }
done
main_network=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).network.physicalName' "$sandbox/access.json")
main_dns=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).network.dnsAddress' "$sandbox/access.json")
labels=$(docker --context "$DOCKER_CONTEXT" network inspect --format '{{index .Labels "com.docker.compose.project"}} {{index .Labels "com.docker.compose.network"}}' "$main_network")
[[ "$labels" == "$project atmosinabox" ]] || { echo 'Sandbox network identity mismatch' >&2; exit 1; }
owned() {
  local type=$1 name=$2 role=$3 actual
  if [[ "$type" == container ]]; then
    actual=$(docker --context "$DOCKER_CONTEXT" container inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "entryway.controller.role"}}' "$name")
  else
    actual=$(docker --context "$DOCKER_CONTEXT" "$type" inspect --format '{{index .Labels "com.docker.compose.project"}} {{index .Labels "entryway.controller.role"}}' "$name")
  fi
  [[ "$actual" == "$project $role" ]] || { echo 'Controller gateway resource ownership mismatch' >&2; return 1; }
}
cleanup() {
  test_status=$?
  cleanup_status=0
  trap - EXIT
  if [[ ! -f "$private/project" || -L "$private/project" || "$(<"$private/project")" != "$project" ]]; then
    echo 'Controller gateway recovery identity is unavailable' >&2
    exit 1
  fi
  for item in "$sidecar:gateway-sidecar" "$tunnel:gateway-tunnel" "$replacement:gateway-replacement"; do
    container=${item%:*}; role=${item#*:}
    if docker --context "$DOCKER_CONTEXT" container inspect "$container" >/dev/null 2>&1; then owned container "$container" "$role" || exit 1; fi
  done
  if docker --context "$DOCKER_CONTEXT" network inspect "$network" >/dev/null 2>&1; then owned network "$network" gateway-test || exit 1; fi
  for volume in "$key_volume" "$replacement_key"; do
    if docker --context "$DOCKER_CONTEXT" volume inspect "$volume" >/dev/null 2>&1; then owned volume "$volume" gateway-test || exit 1; fi
  done
  if [[ -f "$private/Caddyfile.original" ]]; then
    cp -- "$private/Caddyfile.original" "$caddyfile" || cleanup_status=1
    docker --context "$DOCKER_CONTEXT" restart "$caddy" >/dev/null || cleanup_status=1
  fi
  rm -f -- "$cert"
  for container in "$tunnel" "$sidecar" "$replacement"; do
    if docker --context "$DOCKER_CONTEXT" container inspect "$container" >/dev/null 2>&1; then docker --context "$DOCKER_CONTEXT" rm --force "$container" >/dev/null || cleanup_status=1; fi
  done
  unset ENTRYWAY_TEST_GATEWAY_NETWORK_OVERLAY
  if ! node "$helper" cleanup "$project" "$sandbox"; then cleanup_status=1; fi
  if docker --context "$DOCKER_CONTEXT" network inspect "$network" >/dev/null 2>&1; then
    for container in "$caddy" "$dns"; do docker --context "$DOCKER_CONTEXT" network disconnect "$network" "$container" >/dev/null 2>&1 || true; done
    docker --context "$DOCKER_CONTEXT" network rm "$network" >/dev/null || cleanup_status=1
  fi
  for volume in "$key_volume" "$replacement_key"; do
    if docker --context "$DOCKER_CONTEXT" volume inspect "$volume" >/dev/null 2>&1; then docker --context "$DOCKER_CONTEXT" volume rm "$volume" >/dev/null || cleanup_status=1; fi
  done
  if [[ "$cleanup_status" == 0 ]]; then rm -f -- "$private/Caddyfile.original" "$private/network.yaml" "$private/project" "$private/replacement.crt"; rmdir "$private" || cleanup_status=1; fi
  if [[ "$cleanup_status" != 0 ]]; then echo 'Controller gateway cleanup failed; rerun controller-gateway cleanup for this sandbox' >&2; exit 1; fi
  exit "$test_status"
}
if [[ "$mode" == cleanup ]]; then
  if [[ -d "$private" ]]; then cleanup; fi
  echo 'Controller gateway recovery state is unavailable' >&2; exit 2
fi
if [[ -e "$private" || -e "$cert" ]] || docker --context "$DOCKER_CONTEXT" network inspect "$network" >/dev/null 2>&1 || docker --context "$DOCKER_CONTEXT" volume inspect "$key_volume" >/dev/null 2>&1 || docker --context "$DOCKER_CONTEXT" container inspect "$sidecar" >/dev/null 2>&1 || docker --context "$DOCKER_CONTEXT" container inspect "$tunnel" >/dev/null 2>&1 || docker --context "$DOCKER_CONTEXT" container inspect "$replacement" >/dev/null 2>&1 || docker --context "$DOCKER_CONTEXT" volume inspect "$replacement_key" >/dev/null 2>&1; then
  echo 'Controller gateway test resources already exist; use controller-gateway cleanup' >&2; exit 2
fi
node "$helper" cleanup "$project" "$sandbox"
mkdir -m 700 "$private"
printf '%s' "$project" > "$private/project"
chmod 400 "$private/project"
trap cleanup EXIT
docker --context "$DOCKER_CONTEXT" network create --internal --label "com.docker.compose.project=$project" --label entryway.controller.role=gateway-test "$network" >/dev/null
docker --context "$DOCKER_CONTEXT" network connect "$network" "$caddy"
docker --context "$DOCKER_CONTEXT" network connect "$network" "$dns"
caddy_ip=$(docker --context "$DOCKER_CONTEXT" inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$caddy")
dns_ip=$(docker --context "$DOCKER_CONTEXT" inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$dns")
node --input-type=module - "$sandbox/access.json" "$private/network.yaml" "$network" "$caddy_ip" "$dns_ip" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {isIP} from 'node:net';
const [accessPath, path, network, caddy, dns] = process.argv.slice(2);
if (isIP(caddy)!==4 || isIP(dns)!==4) throw Error('Invalid private bridge');
const access=JSON.parse(readFileSync(accessPath));
const hosts=[...new Set(access.endpoints.filter(x=>x.kind==='exact').map(x=>x.hostname))];
if (!hosts.includes('cluster1.atmosbox.test') || hosts.some(x=>!/^[-.a-z0-9]+$/.test(x))) throw Error('Invalid sandbox endpoints');
writeFileSync(path,`services:\n  pds1:\n    networks: !override\n      - controller-private\n    dns: !override\n      - ${dns}\n    extra_hosts: !override\n${hosts.map(x=>`      - ${JSON.stringify(`${x}:${caddy}`)}\n`).join('')}networks:\n  controller-private:\n    external: true\n    name: ${JSON.stringify(network)}\n`,{mode:0o400,flag:'wx'});
JS
export ENTRYWAY_TEST_GATEWAY_NETWORK_OVERLAY="$private/network.yaml"
node "$helper" launch "$project" "$sandbox"
node "$helper" verify "$project" "$sandbox"
image=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).toolImage' "$launch/state.json")
docker --context "$DOCKER_CONTEXT" run --rm --network none --mount "type=bind,src=$root/tests/atmosphere,dst=/app/tests/atmosphere,readonly" --mount "type=bind,src=$root/dist/src/pds/deployment-controller-contract.js,dst=/app/dist/src/pds/deployment-controller-contract.js,readonly" --workdir /app --entrypoint node "$image" --test tests/atmosphere/controller-gate-store.test.mjs tests/atmosphere/controller-lease-fixture.test.mjs
origin=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).containerId' "$launch/state.json")
address=$(docker --context "$DOCKER_CONTEXT" inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$origin")
count=$(docker --context "$DOCKER_CONTEXT" inspect --format '{{len .NetworkSettings.Networks}}' "$origin")
[[ "$count" == 1 && -n "$address" ]] || { echo 'Destination network is not isolated' >&2; exit 1; }
identity=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
docker --context "$DOCKER_CONTEXT" volume create --label "com.docker.compose.project=$project" --label entryway.controller.role=gateway-test "$key_volume" >/dev/null
docker --context "$DOCKER_CONTEXT" run --rm --network none --user 0:0 --mount "type=volume,src=$key_volume,dst=/gateway-key" --entrypoint openssl "$image" req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=controller-gateway.test -addext subjectAltName=DNS:controller-gateway.test -keyout /gateway-key/key.pem -out /gateway-key/cert.pem >/dev/null 2>&1
docker --context "$DOCKER_CONTEXT" run --rm --network none --user 0:0 --mount "type=volume,src=$key_volume,dst=/gateway-key,readonly" --entrypoint cat "$image" /gateway-key/cert.pem > "$cert"
docker --context "$DOCKER_CONTEXT" run -d --user 0:0 --name "$sidecar" --label "com.docker.compose.project=$project" --label entryway.controller.role=gateway-sidecar --network "container:$origin" --mount "type=volume,src=$key_volume,dst=/gateway-key,readonly" --mount "type=bind,src=$root/tests/atmosphere/controller-gateway.mjs,dst=/gateway.mjs,readonly" --env "CONTROLLER_GATEWAY_ID=$identity" --entrypoint node "$image" /gateway.mjs >/dev/null
node "$helper" verify "$project" "$sandbox" >/dev/null
docker --context "$DOCKER_CONTEXT" run -d --name "$tunnel" --label "com.docker.compose.project=$project" --label entryway.controller.role=gateway-tunnel --network "$main_network" --mount "type=bind,src=$root/tests/atmosphere/controller-gateway-tunnel.mjs,dst=/tunnel.mjs,readonly" --env "CONTROLLER_GATEWAY_ADDRESS=$address" --entrypoint node "$image" /tunnel.mjs >/dev/null
docker --context "$DOCKER_CONTEXT" network connect "$network" "$tunnel"
tunnel_ip=$(docker --context "$DOCKER_CONTEXT" inspect --format "{{(index .NetworkSettings.Networks \"$main_network\").IPAddress}}" "$tunnel")
cp -- "$caddyfile" "$private/Caddyfile.original"
node --input-type=module - "$caddyfile" "$address" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const [path,address]=process.argv.slice(2);const source=readFileSync(path,'utf8');
const old='cluster1.atmosbox.test {\n  tls internal\n  reverse_proxy pds1:3000\n}';
if(source.split(old).length!==2)throw Error('Unexpected public ingress route');
const next=`cluster1.atmosbox.test {\n  tls internal\n  reverse_proxy https://${address}:3443 {\n    header_up Host {host}\n    transport http {\n      tls_server_name controller-gateway.test\n      tls_trust_pool file /authority/controller-gateway-test.crt\n    }\n  }\n}`;
writeFileSync(path,source.replace(old,next));
JS
docker --context "$DOCKER_CONTEXT" exec "$caddy" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
docker --context "$DOCKER_CONTEXT" restart "$caddy" >/dev/null
new_caddy_ip=$(docker --context "$DOCKER_CONTEXT" inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$caddy")
[[ "$new_caddy_ip" == "$caddy_ip" ]] || { echo 'Ingress address changed during restart' >&2; exit 1; }
if [[ "${CONTROLLER_GATEWAY_TEST_INTERRUPT:-}" == after-route ]]; then kill -KILL "$$"; fi
if [[ "${CONTROLLER_GATEWAY_TEST_FAIL:-}" == after-route ]]; then echo 'Injected test assertion failure' >&2; exit 1; fi
probe() {
  docker --context "$DOCKER_CONTEXT" run --rm --network "$main_network" --dns "$main_dns" --mount "type=bind,src=$cert,dst=/gateway.crt,readonly" --mount "type=bind,src=$root/tests/atmosphere/controller-gateway-probe.mjs,dst=/probe.mjs,readonly" --mount "type=volume,src=${project}_public-ca,dst=/ca,readonly" --entrypoint node "$image" /probe.mjs "$tunnel_ip" /gateway.crt "$identity" /ca/root.crt "${1:-live}"
}
probe
docker --context "$DOCKER_CONTEXT" exec "$origin" node -e 'Promise.all(["https://entryway.atmosbox.test/_health","https://plc.atmosbox.test/"].map((url)=>fetch(url,{signal:AbortSignal.timeout(4000),redirect:"manual"}).then(r=>({status:r.status}),e=>({error:e.cause?.code??e.name})))).then(results=>{console.log("PDS egress",JSON.stringify(results));process.exit(results[0].status===200&&Number.isInteger(results[1].status)?0:1)})'
docker --context "$DOCKER_CONTEXT" run --rm --network "$main_network" --entrypoint node "$image" -e 'const net=require("node:net"),s=net.connect({host:process.argv[1],port:3000});s.setTimeout(1500);s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0));s.on("timeout",()=>{s.destroy();process.exit(0)})' "$address"
node "$helper" verify "$project" "$sandbox" >/dev/null
docker --context "$DOCKER_CONTEXT" restart "$origin" >/dev/null
if node "$helper" verify "$project" "$sandbox" >/dev/null 2>&1; then echo 'Restarted launch was accepted' >&2; exit 1; fi
probe stale
docker --context "$DOCKER_CONTEXT" compose --project-name "$project" -f "$sandbox/compose.yaml" -f "$launch/compose.json" -f "$private/network.yaml" up -d --no-deps --force-recreate --wait pds1 >/dev/null
if node "$helper" verify "$project" "$sandbox" >/dev/null 2>&1; then echo 'Replaced launch was accepted' >&2; exit 1; fi
probe stale
new_origin=$(docker --context "$DOCKER_CONTEXT" ps --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=pds1' --format '{{.ID}}')
new_address=$(docker --context "$DOCKER_CONTEXT" inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$new_origin")
[[ "$new_address" == "$address" ]] || { echo 'Replacement did not reuse the tested address' >&2; exit 1; }
new_identity=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
docker --context "$DOCKER_CONTEXT" volume create --label "com.docker.compose.project=$project" --label entryway.controller.role=gateway-test "$replacement_key" >/dev/null
docker --context "$DOCKER_CONTEXT" run --rm --network none --user 0:0 --mount "type=volume,src=$replacement_key,dst=/gateway-key" --entrypoint openssl "$image" req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=controller-gateway.test -addext subjectAltName=DNS:controller-gateway.test -keyout /gateway-key/key.pem -out /gateway-key/cert.pem >/dev/null 2>&1
docker --context "$DOCKER_CONTEXT" run --rm --network none --user 0:0 --mount "type=volume,src=$replacement_key,dst=/gateway-key,readonly" --entrypoint cat "$image" /gateway-key/cert.pem > "$private/replacement.crt"
docker --context "$DOCKER_CONTEXT" run -d --user 0:0 --name "$replacement" --label "com.docker.compose.project=$project" --label entryway.controller.role=gateway-replacement --network "container:$new_origin" --mount "type=volume,src=$replacement_key,dst=/gateway-key,readonly" --mount "type=bind,src=$root/tests/atmosphere/controller-gateway.mjs,dst=/gateway.mjs,readonly" --env "CONTROLLER_GATEWAY_ID=$new_identity" --entrypoint node "$image" /gateway.mjs >/dev/null
probe stale
[[ -z "$(docker --context "$DOCKER_CONTEXT" logs "$replacement")" ]] || { echo 'Old pins forwarded a replacement request' >&2; exit 1; }
docker --context "$DOCKER_CONTEXT" run --rm --network "$main_network" --dns "$main_dns" --mount "type=bind,src=$private/replacement.crt,dst=/gateway.crt,readonly" --mount "type=bind,src=$root/tests/atmosphere/controller-gateway-probe.mjs,dst=/probe.mjs,readonly" --mount "type=volume,src=${project}_public-ca,dst=/ca,readonly" --entrypoint node "$image" /probe.mjs "$tunnel_ip" /gateway.crt "$new_identity" /ca/root.crt replacement
[[ "$(docker --context "$DOCKER_CONTEXT" logs "$replacement" | wc -l)" -ge 2 ]] || { echo 'Replacement control did not reach the gateway' >&2; exit 1; }
echo 'Gateway probe: isolated ingress, verified TLS, managed challenge, restart and replacement refusal passed; staged admission remains unavailable'
