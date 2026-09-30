#!/bin/sh
set -eu
for nssdb in /root/.pki/nssdb /root/.local/share/pki/nssdb; do
  mkdir -p "$nssdb"
  certutil -N --empty-password -d "sql:$nssdb"
  certutil -A -d "sql:$nssdb" -n hypercerts-entryway -t 'C,,' -i /ca/root.crt
done
exec "$@"
