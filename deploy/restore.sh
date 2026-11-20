#!/usr/bin/env bash
# Datenbank aus einer Sicherung wiederherstellen.
# Aufruf: ./restore.sh backups/doit_2026-11-20_0215.dump
set -euo pipefail
cd "$(dirname "$0")"
FILE="${1:?Bitte Backup-Datei angeben, z. B. ./restore.sh backups/doit_2026-11-20_0215.dump}"
[ -f "$FILE" ] || { echo "Datei nicht gefunden: $FILE"; exit 1; }
read -r -p "Aktuelle Daten werden durch $FILE ersetzt. Fortfahren? [ja/nein] " answer
[ "$answer" = "ja" ] || exit 1
docker compose stop app worker
docker compose exec -T db pg_restore -U doit -d doit --clean --if-exists --no-owner < "$FILE"
docker compose start app worker
echo "Wiederhergestellt. Geräte laden ihre Daten automatisch neu, sobald sie sich verbinden."
