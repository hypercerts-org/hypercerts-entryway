#!/usr/bin/env bash
# Author and prepare versions inside owned AiaB tooling; never publish or tag.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command=${1:-status}
if (( $# > 0 )); then shift; fi
case "$command" in
  status) npm_command=(npm run changeset:check -- "$@") ;;
  add) npm_command=(npm run changeset -- add "$@") ;;
  version)
    (( $# == 0 )) || { echo 'version takes no arguments' >&2; exit 2; }
    npm_command=(npm run version-packages)
    ;;
  *) echo 'Usage: ./scripts/changesets.sh [status [options] | add [options] | version]' >&2; exit 2 ;;
esac
source "$root/tests/support/rootless-docker.sh"
sandbox=${SANDBOX_CHECKOUT:-"$root/tests/.runtime/changesets-tooling"}
project="hypercerts-entryway-changesets-$(date +%s)-$$"
export SANDBOX_CHECKOUT="$sandbox"
export SOURCE_CHECKOUT="$root"
git_dir=$(git -C "$root" rev-parse --absolute-git-dir)
SOURCE_GIT_COMMON_DIR=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)
# Preserve commondir's relative layout as well as the explicit Git environment.
case "$git_dir" in
  "$SOURCE_GIT_COMMON_DIR") TOOLING_GIT_DIR=/git/common ;;
  "$SOURCE_GIT_COMMON_DIR"/*) TOOLING_GIT_DIR="/git/common/${git_dir#"$SOURCE_GIT_COMMON_DIR"/}" ;;
  *) echo 'Git worktree metadata is outside its common directory' >&2; exit 2 ;;
esac
export TOOLING_GIT_DIR SOURCE_GIT_COMMON_DIR
"$root/tests/atmosphere/prepare.sh"
cp "$root/tests/atmosphere/changesets.yaml" "$sandbox/changesets.yaml"
compose=(docker --context rootless compose --project-name "$project" -f "$sandbox/changesets.yaml")
"${compose[@]}" build changesets
tty_options=()
if ! [[ -t 0 && -t 1 ]]; then tty_options=(-T); fi
"${compose[@]}" run --rm --no-deps "${tty_options[@]}" changesets "${npm_command[@]}"
