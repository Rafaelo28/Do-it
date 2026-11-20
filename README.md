# Do-it

Selbst gehostete Todo-App für eine kleine Gruppe – Aufgaben in normaler Sprache, Erinnerungen per Push, offline nutzbar, synchron auf allen Geräten.

> „Morgen 15 Uhr Zahnarzt anrufen #Gesundheit, erinnere mich 30 min vorher“
> → *Zahnarzt anrufen* · Sa, 15:00 · Projekt Gesundheit · Erinnerung 14:30

## Was drin ist

- **Eingabe in normaler Sprache** (Deutsch, nur Regeln, keine KI): Datum, Uhrzeit, Wochentage, Feiertage (inkl. Ostern), „jeden letzten Freitag im Monat“, „alle 3 Tage nach Erledigung“, Erinnerungen, Deadlines, Dauer, Priorität, `#Projekt`, `@Label`, `+Person`, „abwechselnd Anna und Ben“. Erkanntes wird beim Tippen markiert und lässt sich mit einem Tipp korrigieren.
- **Projekte automatisch zuordnen**: einfach den Projektnamen in den Satz schreiben („Haushalt Bad putzen“), oder gezielt mit `.Name` bzw. `#Name` (auch abgekürzt: `.haus`). Dazu eigene Stichwörter pro Projekt und Vorschläge aus deinen bisherigen Aufgaben.
- **Erinnerungen und Benachrichtigungen** auf Android, Desktop und iPad (als Home-Bildschirm-App), mit „Erledigt“, „In 1 Std.“ und „Morgen“ direkt in der Benachrichtigung, dazu ein Morgen-Briefing.
- **Offline zuerst**: Jedes Gerät hat eine lokale Kopie, Änderungen werden im Hintergrund synchronisiert (feldweise, ohne Datenverlust bei gleichzeitigen Änderungen).
- **Für ein paar Leute**: Einladungslinks, geteilte Projekte mit Rollen, Zuweisen, rotierende Haushaltsaufgaben, Kommentare, Verlauf.
- **Erledigt-Übersicht**: alles, was in den letzten 7, 30 oder 90 Tagen erledigt wurde, nach Tagen sortiert, auch jede Runde wiederkehrender Aufgaben und was die anderen geschafft haben.
- **Abgesichert**: Einrichtungscode fürs erste Konto, Zwei-Faktor-Anmeldung mit Authenticator-App, Geräteliste, strikte Browser-Sicherheitsregeln, Anfrage-Limits, gehärtete Container ([Absicherung](docs/betrieb.md#9-absicherung)).
- **Claude-Anbindung** wie bei Todoist: MCP-Connector mit Anmeldung per Freigabe. Claude liest und pflegt Aufgaben und schreibt dir tägliche Briefings, die als Benachrichtigung ankommen ([docs/claude.md](docs/claude.md)).
- **Kalender-Abo** (iCal), Todoist-Import, Mehrzeilen-Eingabe, „Teilen → Do-it“ auf Android, Tastenkürzel am Desktop.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `packages/parser` | Deutscher Regel-Parser mit großem Test-Korpus |
| `packages/shared` | Datenmodell, Datum/Zeitzonen, Wiederholungen, Sync-Format |
| `apps/server` | Fastify + PostgreSQL: Login, Sync, WebSocket, Push, Erinnerungs-Dienst |
| `apps/web` | React-PWA mit IndexedDB, Service Worker und Sync-Client |
| `deploy` | Dockerfile, Compose (App, Worker, DB, Backup, Cloudflare Tunnel), Skripte |
| `docs` | [Bauplan](docs/BAUPLAN.md), [Betriebsanleitung](docs/betrieb.md), [Claude verbinden](docs/claude.md) |

## Schnellstart (Server)

```bash
cd deploy
cp .env.example .env      # Passwort und Cloudflare-Tunnel-Token eintragen
docker compose up -d --build
docker compose logs app | grep Einrichtungscode   # Code für das erste Konto
```

Alles Weitere (Proxmox-VM, Cloudflare, Geräte, Backups, Updates) steht in **[docs/betrieb.md](docs/betrieb.md)**.

## Entwicklung

```bash
pnpm install
pnpm test        # Parser-, Modell- und Server-Tests (Server-Tests brauchen PostgreSQL, siehe docs/betrieb.md)
pnpm typecheck
pnpm build
```
