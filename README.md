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
- **Deadlines und Dauern**: „Bericht schreiben morgen, Deadline Freitag“ oder „spätestens 30.11.“ setzt eine Deadline neben dem geplanten Tag; „14–16 Uhr“, „2 Std“ oder „2 Stunden lang“ eine Dauer. Überschneidet sich eine Zeit mit einem anderen Termin, sagt die Eingabe Bescheid.
- **Termine ohne To-do**: Arzt, Treffen, Chorprobe … stehen im Kalender und im Tagesplan unter „Heute“, werden aber nicht abgehakt und zählen nicht als Aufgaben. In der Eingabe „Termin“ anklicken (im Kalender ist das bei einem Klick auf freie Zeit schon vorausgewählt). Wiederholungen und Erinnerungen gehen auch, im Kalender-Abo erscheinen wiederkehrende Termine als echte Serie.
- **Kalender** mit Tag, Woche und Monat: Aufgaben mit Uhrzeit blocken ihre Dauer als Zeitblock, lassen sich verschieben und länger ziehen, Aufgaben ohne Datum zieht man von der Seite hinein. Deadlines und künftige Wiederholungen sind sichtbar, ein Klick auf freie Zeit legt eine Aufgabe dort an. Auf dem Handy: Wochenleiste über dem Tag, Monat mit Punkten und Tagesliste darunter, Wischen zum Blättern.
- **Darstellungen** für jedes Projekt, Label und jeden Filter: Liste, Board (nach Abschnitt, Projekt, Priorität oder Fälligkeit), Kalender oder Tabelle – pro Person gespeichert.
- **Eigene Filter** (bis 150) mit einer Abfragesprache auf Deutsch, die auch Todoist-Schreibweisen versteht: `(heute | überfällig) & p1`, `##Arbeit & 7 tage`, `deadline 14 tage`, `@einkaufen & !wiederkehrend`. Claude kann sie bei der Suche ebenfalls nutzen.
- **Erscheinungsbild**: Hell, dunkel oder wie das Gerät, zehn Akzentfarben oder eine eigene, fünf Stile (Papier, Klar, Kühl, Warm, Tiefschwarz), Ecken, Dichte und Schriftgröße – auf allen Geräten gleich.
- **Startseite** frei wählbar: Heute, Eingang, Demnächst, Kalender, ein Projekt, Filter oder Label.
- **Karma**: Punkte fürs Erledigen (mehr für wichtige und pünktliche Aufgaben), Tages- und Wochenziele, Serien und zehn Stufen vom Samenkorn bis zum Urwald. Freie Tage und Urlaub unterbrechen keine Serie.
- **Profilbilder**: eigenes Bild hochladen und zuschneiden. Es erscheint bei Zuweisungen, Kommentaren und in der Erledigt-Übersicht.
- **Umzug von Todoist**: per API-Schlüssel (jeder Todoist-Tarif) mit Projekten, Unterprojekten, Abschnitten, Unteraufgaben, Labels, Kommentaren und Erinnerungen, oder aus einem Backup (ZIP) bzw. CSV-Export. Ein zweiter Durchlauf legt nichts doppelt an.
- **Kalender-Abo** (iCal), Mehrzeilen-Eingabe, „Teilen → Do-it“ auf Android, Tastenkürzel am Desktop.

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
