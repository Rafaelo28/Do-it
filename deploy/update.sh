#!/usr/bin/env bash
# Neue Version einspielen: Code holen, Image bauen, Dienste neu starten.
set -euo pipefail
cd "$(dirname "$0")"
echo "▶ Sicherung vor dem Update"
docker compose exec -T backup /bin/sh /backup.sh now || echo "  (Sicherung übersprungen)"
echo "▶ Code aktualisieren"
git pull --ff-only
echo "▶ Image bauen und neu starten"
docker compose build app
docker compose up -d
docker image prune -f >/dev/null
echo "▶ Status"
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health && echo
