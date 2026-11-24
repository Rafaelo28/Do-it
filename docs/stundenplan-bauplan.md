# Bauplan: Aktueller Stundenplan (VpMobil24) in Do-it – zusammen mit TimetableX

Stand: November 2026 · **Plan, noch nicht umgesetzt**

## Ziel

- Do-it zeigt **deinen** Stundenplan mit den tagesaktuellen Änderungen:
  - Ausfall, Vertretung, Raumänderung
  - Zusatzinfos des Tages
- Du siehst ihn im Kalender und unter „Heute“.
- Gespeichert und angezeigt werden **nur deine Klasse und deine Fächer/Kurse**, nichts von anderen Klassen.
- Optional:
  - eine Benachrichtigung bei Änderungen („Morgen 1. Stunde Mathe entfällt“)
  - Hausaufgaben mit einem Klick zur nächsten Stunde eines Fachs anlegen
- Die Daten kommen über **TimetableX**, die Open-Source-App deines Freundes. Sie liest den Plan schon von
  stundenplan24.de und erkennt Ausfälle und Änderungen zuverlässig. Was Do-it zusätzlich braucht, fließt als
  kleine Pull Requests zu TimetableX zurück, davon haben beide Apps etwas.

## Was es schon gibt

**Do-it**
- Dein Stundenplan steht als stumme, wöchentliche Termine im Kalender (keine Benachrichtigungen).
- Server mit Worker (läuft regelmäßig), Push-Benachrichtigungen, Morgen-Briefing und Claude-Anbindung.

**TimetableX** (Next.js, `github.com/xTimetablex/TimetableX`)
- Lädt `https://www.stundenplan24.de/<Schulnummer>/wplan/wdatenk/WPlanKl_<JJJJMMTT>.xml` mit den
  Schul-Zugangsdaten und wertet aus:
  - Klasse, Stunde, Fach, Lehrkraft, Raum, Info
  - Änderungs-Kennzeichen `*Ae`
  - Tagesinfos
- Erkennt Ausfälle (`isCancelledEntry`: leeres Fach mit Änderungs-Kennzeichen oder „entfällt/Ausfall“ in der Info).
- Hat eine **öffentliche JSON-Schnittstelle**:
  `GET /api/public/timetable?class=9/2&view=week&date=24.11.2026`, Anmeldung per Basic Auth
  `<Schulnummer>.<Benutzer>:<Passwort>`. Sie filtert **auf dem Server** nach Klasse und puffert 60 Sekunden.
  Die Zugangsdaten speichert sie dabei nicht.

**Lücken für Do-it**

| Lücke | Folge |
|---|---|
| Einträge haben nur die Stundennummer, **keine Uhrzeit** | Do-it braucht ein Stundenraster (welche Stunde wann ist) |
| **Keine Kurs-Kennung** | In der Oberstufe lässt sich nur nach Fach filtern, nicht nach deinem Kurs |
| Kein Filter nach Fächern in der Schnittstelle | Do-it bekommt alle Stunden der Klasse und filtert selbst |
| Kein `ETag`/`Last-Modified` | Do-it muss jedes Mal den ganzen Plan abholen |
| **Keine Lizenzdatei** im Repository | API-Nutzung und PRs sind kein Problem; Code übernehmen ginge erst mit Lizenz (z. B. MIT) |

## Architektur

```
stundenplan24.de ──► TimetableX  /api/public/timetable?class=<deine Klasse>&view=week
                                        │  (filtert auf deine Klasse)
                                        ▼
                     Do-it-Server: Worker alle 15 Min.
                       · filtert auf deine Fächer/Kurse
                       · speichert NUR das (verschlüsselte Zugangsdaten, 30 Tage)
                       · merkt Änderungen → Push, Briefing
                                        │  (Sync wie Aufgaben, offline verfügbar)
                                        ▼
                     Do-it-App: Kalender-Ebene „Stundenplan“, Heute, Claude
```

Die Datenquelle wird in Do-it ein austauschbares Modul (`TimetableSource`):

- **A – TimetableX (Start):** Do-it nutzt den vorhandenen Parser und die Ausfall-Erkennung. Die Schul-Zugangsdaten
  gehen bei jedem Abruf an den TimetableX-Server deines Freundes. Er speichert sie nicht, sieht sie aber.
- **B – direkt stundenplan24.de (Ausweichweg, später):** Kein Umweg über einen fremden Server, dafür ein eigener
  Parser in Do-it. Die XML-Datei enthält zwar alle Klassen, Do-it filtert aber sofort im Speicher und
  verwirft den Rest.

## Do-it: Bausteine

1. **Einstellungen → Claude & Kalender → „Stundenplan verbinden“**
   - Adresse der TimetableX-Instanz, Schulnummer, Benutzer und Passwort (die Schüler-Zugangsdaten aus VpMobil24).
     Der Server speichert sie **verschlüsselt** (AES-256-GCM mit dem Server-Schlüssel) und gibt sie nie wieder an
     den Browser.
   - Knopf **„Verbindung prüfen“** lädt die Woche und zeigt die Klassenliste, dann wählst du deine Klasse.
   - **Fächer/Kurse wählen:** Do-it listet die Fächer deiner Klasse aus den letzten zwei Wochen, du hakst ab, was
     du nicht hast (wie „Fächer ausblenden“ in TimetableX).
   - **Stundenraster** (1. Stunde 07:30–08:15 …): Do-it füllt es aus deinen eingetragenen Terminen vor
     (Montag 8:00 Mathe usw.). Sobald TimetableX Uhrzeiten liefert (PR 1), kommt es automatisch.
   - **Fachnamen:** Kürzel wird zu Name (MA → Mathe, DE → Deutsch), ebenfalls aus deinen Terminen vorbelegt.
2. **Server-Datenbank** (neue Migration):
   - `timetable_sources`: Nutzer, verschlüsselte Zugangsdaten, Klasse, Fächer, Raster, Namen, letzter Erfolg/Fehler
   - `timetable_days`: Nutzer, Datum, Stunden (nur deine), Tagesinfos, Zeitstempel des Plans, Prüfsumme
3. **Worker:**
   - Mo–Fr 6–17 Uhr alle 15 Minuten heute und morgen, 17–22 Uhr stündlich morgen
     (Pläne für den nächsten Tag kommen oft abends), am Wochenende einmal für Montag.
   - Bei Fehlern wartet er schrittweise länger.
   - Bei „Zugangsdaten falsch“ (401) pausiert er und zeigt einen Hinweis in den Einstellungen.
4. **Zur App:**
   - Neuer Sync-Bereich bzw. Endpunkt `GET /api/timetable?from=&to=`.
   - Bei Änderungen stupst der Server die App per WebSocket an.
   - In der App liegt der Plan zwischengespeichert, du siehst ihn also auch offline.
5. **Anzeige:**
   - Kalender-Ebene „Stundenplan“ (ein- und ausschaltbar) und ein Abschnitt „Stundenplan heute“ unter „Heute“.
   - Ausfall: durchgestrichen mit „entfällt“. Vertretung, Raum- oder Lehrkraftänderung: farbig markiert, mit der
     Info aus dem Plan. Tagesinfos oben.
   - Ist die Verbindung aktiv, bietet Do-it an, deine selbst eingetragenen Stundenplan-Termine **auszublenden**
     (nicht zu löschen). Do-it erkennt sie daran, dass sie stumm sind, sich wöchentlich wiederholen und der Titel
     ein Fachname ist.
6. **Hausaufgaben:** In einer Stunde erstellt „Aufgabe zur nächsten Stunde“ eine Aufgabe, fällig zur nächsten
   Stunde dieses Fachs (aus dem Plan bzw. dem Wochenmuster), im Projekt „Schule“.
7. **Benachrichtigungen (optional, einschaltbar):**
   - eine Nachricht pro Änderung für heute oder morgen, nie zwischen 21 und 6 Uhr
   - im Morgen-Briefing zusammengefasst („Heute 2 Änderungen“)
8. **Claude:** neues Werkzeug `get_timetable(date)` („Was habe ich morgen in der 3. Stunde?“).
9. **Datenschutz:**
   - nur deine Klasse und Fächer werden gespeichert, Pläne höchstens 30 Tage
   - „Trennen“ löscht Zugangsdaten und Pläne
   - Andere Do-it-Nutzer sehen nichts davon, jede Person verbindet ihren eigenen Plan.

## TimetableX: Vorschläge für Pull Requests

Alle klein, jeweils mit Tests und nach den Regeln des Repos: Vitest (`bun run test`), nur `package-lock.json`,
deutsche Texte, `projectAudit`-Prüfungen, keine Zugangsdaten im Browser.

| # | PR | Nutzen für TimetableX | Nutzen für Do-it |
|---|---|---|---|
| 1 | **Uhrzeiten** `start`/`end` an Einträgen, wenn das XML sie liefert (rückwärtskompatibel) | Zeiten in der Tagesansicht, Grundlage für das geplante iCal-Abo | Kein Stundenraster von Hand |
| 2 | **Fächer-Filter** in der öffentlichen API: `?class=9/2&subjects=MA,DE,EN` | Andere API-Nutzer bekommen genau ihre Stunden | Weniger Daten, nur deine Stunden |
| 3 | **`ETag`/`Last-Modified`** aus dem Plan-Zeitstempel, Antwort `304`, wenn nichts neu ist | Weniger Last | Sparsames Nachfragen alle 15 Min. |
| 4 | **VpMobil-Format** `mobil/mobdaten/PlanKl<Datum>.xml` als zweite Quelle, falls `wplan` fehlt oder weniger enthält (laut Indiware-Format mit Zeiten, Kursen und Klausuren; mit echtem Plan prüfen) | Funktioniert an mehr Schulen | Zeiten und Kurse |
| 5 | **Kurs-Kennung** (`course`/`lessonId`) an Einträgen | „Nur meine Kurse“ für die Oberstufe | Genauer Filter in der Oberstufe |
| 6 | später: das **iCal-Abo** aus TimetableX' eigenem Design-Dokument | Plan in Google/Apple-Kalender | Zusätzlich als normales Kalender-Abo nutzbar |

Eine Lizenzdatei kann nur dein Freund selbst entscheiden, das bitte nicht per PR.

**Zugriff für PRs:** Diese Arbeitssitzung kann TimetableX nur lesen. Für PRs gibt es zwei Wege:
- Dein Freund installiert die Claude-GitHub-App auf seinem Repository oder fügt dich als Mitwirkenden hinzu.
- Du forkst TimetableX in dein GitHub-Konto. Dann arbeite ich im Fork, und die PRs gehen vom Fork an ihn.

## Reihenfolge

| Phase | Inhalt | Wo |
|---|---|---|
| 0 – Klären | Liefert eure Schule `wplan` oder `mobil` (zeigt „Verbindung prüfen“)? Ist dein Freund mit der API-Nutzung einverstanden, und unter welcher Adresse läuft TimetableX? Klasse oder Oberstufe mit Kursen? | du + Freund |
| 1 – Grundgerüst | Verbindung, Klasse + Fächer, Stundenraster aus deinen Terminen, Worker, Anzeige mit Änderungen in Kalender und Heute | Do-it |
| 2 – Komfort | Benachrichtigungen, Briefing, Claude-Werkzeug, Hausaufgaben-Knopf, eigene Termine ausblenden | Do-it |
| 3 – Quelle verbessern | PR 1–3, danach 4–5; Do-it nutzt Zeiten und Fächer-Filter automatisch, sobald sie da sind | TimetableX |
| 4 – optional | direkter stundenplan24-Abruf als Ausweichweg; allgemeines „Kalender abonnieren“ (iCal) in Do-it | Do-it |

## Offene Fragen

1. Bist du in einer normalen Klasse (z. B. „9/2“) oder in der Oberstufe mit Kursen?
2. Läuft eure Schule schon in TimetableX? Gleiche Schulnummer und gleiche Zugangsdaten wie in VpMobil24?
3. Ist es für dich in Ordnung, dass die Schul-Zugangsdaten beim Abruf über den TimetableX-Server gehen?
   Wenn nicht, starten wir mit Quelle B (direkt).
4. Möchtest du Benachrichtigungen bei Änderungen oder lieber nur die Anzeige?
