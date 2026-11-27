#!/usr/bin/env bash
# A failed or unverifiable restore must never restart a partially restored fleet.
restore_authority_and_restart() {
  configcmd restore-key || return 1
  compose restart entryway pds1 pds2 >/dev/null
}
