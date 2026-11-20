# Do-it mit Claude verbinden

Do-it hat einen eigenen **MCP-Connector** (wie Todoist). Damit kann Claude deine Aufgaben lesen, neue anlegen, abhaken und dir Zusammenfassungen schreiben. Die Zusammenfassungen landen in Do-it unter **Briefings**, oben in **Heute** und als Benachrichtigung auf deinen Geräten.

> Datenschutz: Claude sieht deine Aufgaben nur, wenn du den Connector verbindest und Claude ihn in einem Gespräch oder einer geplanten Aufgabe benutzt. Die Verbindung lässt sich jederzeit in Do-it unter **Einstellungen → Claude → Trennen** aufheben. Der Parser in der App selbst nutzt weiterhin keine KI.

## 1. Connector hinzufügen

**Adresse:** `https://do-it.gerda-hilft.de/mcp` (steht auch in Do-it unter Einstellungen → Claude)

### Claude im Browser, als Desktop-App oder auf dem Handy

1. In Claude **Einstellungen → Konnektoren → Benutzerdefinierten Konnektor hinzufügen**.
2. Name: `Do-it`, URL: die Adresse oben. Weitere Felder leer lassen.
3. **Verbinden** klicken. Es öffnet sich Do-it: anmelden (falls nötig) und **Erlauben** tippen.
4. Fertig. In einem neuen Chat ist Do-it jetzt als Werkzeug verfügbar. Ausprobieren: *„Was steht heute in Do-it an?“*

Bei einem Team- oder Enterprise-Konto von Claude muss eventuell ein Admin benutzerdefinierte Konnektoren erlauben.

### Claude Code

```bash
claude mcp add --transport http do-it https://do-it.gerda-hilft.de/mcp
```

Danach in Claude Code `/mcp` aufrufen und die Anmeldung starten (Freigabe wie oben). Alternativ ohne Browser-Freigabe mit einem persönlichen Schlüssel aus Do-it (Einstellungen → Claude → Schlüssel erstellen):

```bash
claude mcp add --transport http do-it https://do-it.gerda-hilft.de/mcp --header "Authorization: Bearer doit_pat_…"
```

## 2. Tägliche Zusammenfassung

Claude braucht nur einen Auftrag zur richtigen Zeit. Der Connector bringt dafür alles mit: `get_overview` liefert den Stand, `post_briefing` speichert das Ergebnis in Do-it und schickt eine Benachrichtigung.

**Auftrag** (auch in Do-it unter Einstellungen → Claude → „Auftrag kopieren“):

> Nutze den Do-it-Konnektor: Rufe get_overview auf und schreibe mir ein kurzes, freundliches Tagesbriefing auf Deutsch (höchstens 12 Zeilen): Termine heute mit Uhrzeit, Überfälliges, was in den nächsten Tagen ansteht, was gestern erledigt wurde und höchstens drei Prioritäten für heute. Speichere es mit post_briefing.

Möglichkeiten:

- **Geplante Aufgabe in Claude:** eine täglich wiederkehrende Aufgabe anlegen (z. B. 6:45 Uhr) mit dem Auftrag oben und dem Do-it-Connector. Dann liegt das Briefing jeden Morgen in der App, und das Handy meldet sich.
- **Von Hand:** im Chat einfach *„Mach mein Tagesbriefing“* schreiben oder die Vorlage **tagesbriefing** des Connectors wählen.
- **Wochenrückblick:** *„Was habe ich diese Woche in Do-it geschafft? Schreib einen Rückblick und speichere ihn als Briefing ‚Wochenrückblick‘.“* (nutzt `get_completed`)

Do-it schickt zusätzlich weiterhin sein eigenes Morgen-Briefing ohne KI (Einstellungen → Benachrichtigungen). Wer nur noch das von Claude möchte, schaltet das eingebaute dort aus.

## 3. Was Claude kann

| Werkzeug | Zweck |
|---|---|
| `get_overview` | Überfällig, Heute, nächste Tage, Erledigtes der letzten 24 h, Projekte |
| `find_tasks` | suchen und filtern (Text, Projekt, Label, Zeitraum, Status, „mir zugewiesen“) |
| `list_projects` | Projekte mit offenen Aufgaben, Mitgliedern und Stichwörtern |
| `add_tasks` | Aufgaben in normaler Sprache anlegen. Der Do-it-Parser erkennt Datum, Wiederholung, `#Projekt`, `@Label`, `+Person`, `!1` und Erinnerungen |
| `update_task` | Titel, Termin („nächsten Montag 9 Uhr“), Priorität, Projekt, Labels, Deadline, Zuständigkeit, wieder öffnen |
| `complete_tasks` | abhaken, wiederkehrende Aufgaben springen weiter |
| `add_comment` | Kommentar an eine Aufgabe |
| `delete_task` | löschen, nur auf ausdrücklichen Wunsch |
| `get_completed` | Erledigtes der letzten Tage |
| `post_briefing` | Zusammenfassung in Do-it speichern und Benachrichtigung schicken |

Claude handelt immer mit **deinen** Rechten: In geteilten Projekten gelten dieselben Rollen wie in der App.

## 4. Technik (für Neugierige)

- Endpunkt `POST /mcp` nach MCP „Streamable HTTP“, zustandslos.
- Anmeldung per OAuth 2.1: Discovery unter `/.well-known/oauth-protected-resource` und `/.well-known/oauth-authorization-server`, dynamische Client-Registrierung, PKCE (S256), Zugangstoken 24 h, Refresh-Token 180 Tage mit Rotation. Tokens liegen nur als SHA-256-Hash in der Datenbank.
- Persönliche Schlüssel (`doit_pat_…`) für Programme ohne Browser.

### Cloudflare

Claude ruft Do-it von Anthropics Servern aus auf. Falls **Bot Fight Mode** oder eine WAF-Regel solche Anfragen blockiert (Fehler beim Verbinden in Claude), in Cloudflare unter **Security → WAF** eine Ausnahme-Regel („Skip“) für `do-it.gerda-hilft.de` mit den Pfaden `/mcp`, `/oauth/` und `/.well-known/` anlegen oder Bot Fight Mode für die Domain ausschalten.
