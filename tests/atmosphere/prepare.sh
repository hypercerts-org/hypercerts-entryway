#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
sandbox=${ENTRYWAY_SANDBOX_ROOT:-"$root/tests/.runtime/atmosphereinabox"}
pin=$(cat "$here/PIN")
if ! test -d "$sandbox/.git"; then
  git clone --quiet --filter=blob:none https://tangled.org/kandake.africa/atmosphereinabox.git "$sandbox"
  git -C "$sandbox" checkout --quiet --detach "$pin"
fi
actual=$(git -C "$sandbox" rev-parse HEAD)
test "$actual" = "$pin" || { echo 'Pinned AiaB revision mismatch; use a separate clean runtime directory.' >&2; exit 2; }
python3 "$here/install.py" "$root" "$sandbox"
