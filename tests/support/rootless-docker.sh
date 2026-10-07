#!/usr/bin/env bash
# Sourced by lifecycle entrypoints; never infer a daemon from the user's default.
export DOCKER_CONTEXT=rootless
unset DOCKER_HOST
rootless_endpoint=$(docker --context rootless context inspect rootless --format '{{.Endpoints.docker.Host}}') || return 1
rootless_security=$(docker --context rootless info --format '{{json .SecurityOptions}}') || return 1
[[ "$rootless_endpoint" == unix:///run/user/*/docker.sock && "$rootless_security" == *'name=rootless'* ]] || { echo 'Expected the explicit rootless Docker endpoint and rootless security option; no fallback is permitted.' >&2; return 1; }
if [[ -n "${ACCEPTANCE_REPORT_DIR:-}" ]]; then
  mkdir -p "$ACCEPTANCE_REPORT_DIR"
  printf '{"context":"rootless","endpoint":"%s","securityOptions":%s}\n' "$rootless_endpoint" "$rootless_security" > "$ACCEPTANCE_REPORT_DIR/docker-context.json"
fi
