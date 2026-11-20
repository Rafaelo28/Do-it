# Do-it

Selbst gehostete Todo-App für eine kleine Gruppe – Aufgaben in normaler Sprache, Erinnerungen per Push, offline nutzbar, synchron auf allen Geräten.

> „Morgen 15 Uhr Zahnarzt anrufen #Gesundheit, erinnere mich 30 min vorher“
> → *Zahnarzt anrufen* · Sa, 15:00 · Projekt Gesundheit · Erinnerung 14:30

## Was drin ist

- **Eingabe in normaler Sprache** (Deutsch, nur Regeln, keine KI): Datum, Uhrzeit, Wochentage, Feiertage (inkl. Ostern), „jeden letzten Freitag im Monat“, „alle 3 Tage nach Erledigung“, Erinnerungen, Deadlines, Dauer, Priorität, `#Projekt`, `@Label`, `+Person`, „abwechselnd Anna und Ben“. Erkanntes wird beim Tippen markiert und lässt sich mit einem Tipp korrigieren.
- **Projekte automatisch zuordnen**: über `#Name`, über den Projektnamen im Satz, über eigene Stichwörter pro Projekt und per Vorschlag aus deinen bisherigen Aufgaben.
- **Erinnerungen und Benachrichtigungen** auf Android, Desktop und iPad (als Home-Bildschirm-App), mit „Erledigt“, „In 1 Std.“ und „Morgen“ direkt in der Benachrichtigung, dazu ein Morgen-Briefing.
- **Offline zuerst**: Jedes Gerät hat eine lokale Kopie, Änderungen werden im Hintergrund synchronisiert (feldweise, ohne Datenverlust bei gleichzeitigen Änderungen).
- **Für ein paar Leute**: Einladungslinks, geteilte Projekte mit Rollen, Zuweisen, rotierende Haushaltsaufgaben, Kommentare, Verlauf.
- **Kalender-Abo** (iCal), Mehrzeilen-Eingabe, „Teilen → Do-it“ auf Android, Tastenkürzel am Desktop.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `packages/parser` | Deutscher Regel-Parser mit großem Test-Korpus |
| `packages/shared` | Datenmodell, Datum/Zeitzonen, Wiederholungen, Sync-Format |
| `apps/server` | Fastify + PostgreSQL: Login, Sync, WebSocket, Push, Erinnerungs-Dienst |
| `apps/web` | React-PWA mit IndexedDB, Service Worker und Sync-Client |
| `deploy` | Dockerfile, Compose (App, Worker, DB, Backup, Cloudflare Tunnel), Skripte |
| `docs` | [Bauplan](docs/BAUPLAN.md) und [Betriebsanleitung](docs/betrieb.md) |

## Schnellstart (Server)

```bash
cd deploy
cp .env.example .env      # Passwort und Cloudflare-Tunnel-Token eintragen
docker compose up -d --build
```

Alles Weitere (Proxmox-VM, Cloudflare, Geräte, Backups, Updates) steht in **[docs/betrieb.md](docs/betrieb.md)**.

## Entwicklung

```bash
pnpm install
pnpm test        # Parser-, Modell- und Server-Tests (Server-Tests brauchen PostgreSQL, siehe docs/betrieb.md)
pnpm typecheck
pnpm build
```
