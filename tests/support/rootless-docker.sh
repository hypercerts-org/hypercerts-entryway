#!/usr/bin/env bash
# Contributors: local runs require rootless; hosted CI explicitly selects default.
export DOCKER_CONTEXT=${ENTRYWAY_DOCKER_CONTEXT:-rootless}
unset DOCKER_HOST
case "$DOCKER_CONTEXT" in
  rootless|default) ;;
  *) echo 'Unsupported Entryway Docker context; no fallback is permitted.' >&2; return 1 ;;
esac
docker_endpoint=$(docker --context "$DOCKER_CONTEXT" context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}') || return 1
docker_security=$(docker --context "$DOCKER_CONTEXT" info --format '{{json .SecurityOptions}}') || return 1
if [[ "$DOCKER_CONTEXT" == rootless ]]; then
  [[ "$docker_endpoint" == unix:///run/user/*/docker.sock && "$docker_security" == *'name=rootless'* ]] || { echo 'Expected the explicit rootless Docker endpoint and security option; no fallback is permitted.' >&2; return 1; }
else
  [[ "$docker_endpoint" == unix:///var/run/docker.sock ]] || { echo 'Expected the standard local Docker endpoint; no fallback is permitted.' >&2; return 1; }
fi
printf 'Verified Docker context: %s\n' "$DOCKER_CONTEXT"
if [[ -n "${ACCEPTANCE_REPORT_DIR:-}" ]]; then
  mkdir -p "$ACCEPTANCE_REPORT_DIR"
  printf '{"context":"%s","endpoint":"%s","securityOptions":%s}\n' "$DOCKER_CONTEXT" "$docker_endpoint" "$docker_security" > "$ACCEPTANCE_REPORT_DIR/docker-context.json"
fi
