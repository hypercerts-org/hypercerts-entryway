#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
: "${SANDBOX_CHECKOUT:?}" "${SANDBOX_PROJECT:?}"
source "$root/tests/support/rootless-docker.sh"
export REGISTRY_BOOTSTRAP_DATABASE="registry_bootstrap_$(date +%s)_$$"
base=(-f "$SANDBOX_CHECKOUT/compose.yaml" -f "$root/tests/atmosphere/stacks/incoming-source-mail.yaml")
registry=(-f "$root/tests/atmosphere/stacks/registry-bootstrap.yaml")
compose() { docker --context "$DOCKER_CONTEXT" compose --project-name "$SANDBOX_PROJECT" "${base[@]}" "${registry[@]}" "$@"; }
stale_compose() { docker --context "$DOCKER_CONTEXT" compose --project-name "$SANDBOX_PROJECT" "${base[@]}" "${registry[@]}" -f "$root/tests/atmosphere/stacks/registry-stale.yaml" "$@"; }
restore() {
  result=$?
  compose stop bootstrap-a bootstrap-b bootstrap-router || result=1
  docker --context "$DOCKER_CONTEXT" compose --project-name "$SANDBOX_PROJECT" "${base[@]}" up -d --no-deps --wait entryway-ingress pds1 || result=1
  exit "$result"
}
trap restore EXIT
node "$root/tests/atmosphere/validate-access.mjs" "$SANDBOX_CHECKOUT/access.json" "$SANDBOX_PROJECT"
gateway=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; const access=JSON.parse(readFileSync(process.argv[1],"utf8")); console.log(access.network.httpsGatewayAddress)' "$SANDBOX_CHECKOUT/access.json")
compose up -d --wait entryway-postgres
compose build test
compose exec -T entryway-postgres createdb -U authority_owner "$REGISTRY_BOOTSTRAP_DATABASE"
compose run --rm --no-deps --entrypoint node -e "REGISTRY_TEST_GATEWAY_IP=$gateway" configure tests/support/prepare-registry-bootstrap.mjs
compose up -d --no-deps --wait bootstrap-a bootstrap-b pds1
compose up -d --no-deps bootstrap-router
compose up -d --no-deps --wait entryway-ingress
compose run --rm --no-deps test node tests/atmosphere/pds-health-network.mjs
compose run --rm --no-deps test node tests/atmosphere/registry-bootstrap-startup.mjs
compose run --rm --no-deps test node tests/atmosphere/registry-bootstrap.mjs
# Stop the processes that were sampling, then restart without a verifier so only
# the independent sweep can advance; restore the verifier for recovery.
compose stop bootstrap-a bootstrap-b
stale_compose up -d --no-deps --wait bootstrap-a bootstrap-b
compose run --rm --no-deps test node tests/atmosphere/registry-stale.mjs stale
compose stop bootstrap-a bootstrap-b
compose up -d --no-deps --wait bootstrap-a bootstrap-b
compose run --rm --no-deps test node tests/atmosphere/registry-stale.mjs recovery
