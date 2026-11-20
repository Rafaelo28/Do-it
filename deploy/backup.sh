#!/bin/sh
# Nächtliches Datenbank-Backup mit Rotation.
# - täglich um BACKUP_TIME_UTC (UTC!) ein pg_dump nach /backups
# - tägliche Sicherungen KEEP_DAYS Tage, Sicherungen vom 1. des Monats ein Jahr lang
set -eu
TIME="${BACKUP_TIME_UTC:-02:15}"
KEEP="${KEEP_DAYS:-14}"

run_backup() {
  stamp=$(date -u +%Y-%m-%d_%H%M)
  file="/backups/doit_${stamp}.dump"
  if pg_dump -Fc -f "${file}.tmp"; then
    mv "${file}.tmp" "$file"
    echo "$(date -u) Backup erstellt: $file ($(du -h "$file" | cut -f1))"
  else
    rm -f "${file}.tmp"
    echo "$(date -u) Backup FEHLGESCHLAGEN" >&2
  fi
  find /backups -name 'doit_*.dump' ! -name 'doit_*-01_*' -mtime +"$KEEP" -delete
  find /backups -name 'doit_*-01_*.dump' -mtime +370 -delete
}

[ "${1:-}" = "now" ] && { run_backup; exit 0; }

echo "Backup-Dienst läuft, tägliche Sicherung um $TIME UTC"
while true; do
  if [ "$(date -u +%H:%M)" = "$TIME" ]; then
    run_backup
    sleep 61
  fi
  sleep 20
done
