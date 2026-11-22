# Bauplan: Do-it als Android-App (APK)

Stand: November 2026 · **noch nicht umgesetzt** – nur Plan und Einschätzung.

## Kurz: Lohnt sich eine APK?

**Im Moment nicht zwingend.** Do-it ist eine installierbare Web-App (PWA). Auf Android erzeugt Chrome beim
„Installieren“ bereits ein echtes Paket (WebAPK): eigenes Symbol, Vollbild, Push-Benachrichtigungen,
funktioniert offline, taucht unter „Apps“ auf und kann geteilten Text empfangen.

Die Probleme beim Abhaken auf dem Handy lagen **nicht** an der Web-Technik, sondern an zwei Fehlern in der
Oberfläche (hängen gebliebener Hover-Zustand, Zieh-Griff direkt neben dem Kreis). Die sind behoben – eine APK
hätte sie nicht gelöst.

Eine eigene APK bringt erst dann echten Mehrwert, wenn man eines davon möchte:

| Wunsch | PWA heute | mit APK |
| --- | --- | --- |
| Symbol, Vollbild, offline, Push | ja | ja |
| an Freunde als Datei weitergeben, ohne „Installieren“ in Chrome | nein | ja |
| **Widget** auf dem Startbildschirm („Heute“, Schnelleingabe) | nein | ja (nur mit Capacitor) |
| **Erinnerungen auf die Minute genau**, auch wenn das Handy im Energiesparmodus ist | meist, aber Push kann sich verzögern | ja (lokale Alarme, nur mit Capacitor) |
| Schnelleingabe als Kachel in den Schnelleinstellungen | nein | ja (nur mit Capacitor) |
| iPad / iPhone | PWA | APK hilft dort nicht |

**Empfehlung:** PWA beibehalten. Wenn eine APK gewünscht ist, in zwei Stufen vorgehen – Stufe 1 ist klein und
risikoarm, Stufe 2 nur, wenn Widgets oder exakte Alarme wirklich gebraucht werden.

---

## Stufe 1: Trusted Web Activity (TWA) – „die PWA als APK“

Eine TWA ist eine sehr dünne Android-Hülle, die die bestehende Web-App im Vollbild öffnet (Chrome-Engine,
ohne Adressleiste). Der gesamte Inhalt kommt weiter von `https://do-it.gerda-hilft.de`; Updates der App
brauchen **keine** neue APK.

**Aufwand:** etwa ein Tag. **Kosten:** keine (kein Play Store nötig, APK direkt weitergeben).

### Schritte

1. **Werkzeug:** [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) (Kommandozeile von Google). Braucht
   Node, ein JDK und das Android-SDK – am einfachsten in einem eigenen Docker-Container, nicht auf dem Server.
2. **Projekt anlegen:** `bubblewrap init --manifest https://do-it.gerda-hilft.de/manifest.webmanifest`
   - Paketname z. B. `de.gerdahilft.doit`
   - Start-URL `/` (die gewählte Startseite greift dann automatisch)
   - Benachrichtigungen: „Notification delegation“ einschalten (Web-Push läuft dann über die App)
3. **Signierschlüssel:** Bubblewrap erzeugt einen Keystore. **Gut sichern** (z. B. im Passwort-Manager und im
   Backup) – ohne ihn lassen sich keine Updates mehr installieren, die alte App müsste deinstalliert werden.
   Der Schlüssel gehört **nicht** ins Git-Repository.
4. **Digital Asset Links:** Damit Android die Adressleiste ausblendet, muss der Server beweisen, dass die App
   zur Seite gehört. Dazu eine Datei `/.well-known/assetlinks.json` ausliefern (Fastify-Route oder statische
   Datei im Web-Build) mit Paketname und SHA-256-Fingerabdruck des Signierschlüssels.
   Der Cloudflare-Tunnel muss den Pfad `/.well-known/` durchlassen (tut er standardmäßig).
5. **Bauen:** `bubblewrap build` → `app-release-signed.apk`.
6. **Verteilen:** APK auf die Handys kopieren (z. B. Link in einer Nachricht) und „Aus unbekannten Quellen
   installieren“ erlauben. Optional später Play Store (einmalig 25 $) oder ein eigenes F-Droid-Repo.
7. **Testen:** Anmelden, Push erlauben, Erinnerung empfangen, Teilen → Do-it, offline öffnen,
   Startseite, Abhaken.

### Was sich im Code ändern würde

- neue Route bzw. Datei `assetlinks.json` (Fingerabdruck als Umgebungsvariable, damit kein Schlüsselmaterial im Code steht)
- ein kurzer Abschnitt in `docs/betrieb.md`: APK bauen, Schlüssel sichern, neue Version verteilen
- sonst nichts – die App bleibt dieselbe

### Risiken

- Ohne gültige Asset Links erscheint oben eine Adressleiste (funktioniert trotzdem).
- Auf Handys ohne Chrome nutzt die TWA einen anderen Browser oder fällt auf einen Browser-Tab zurück.

---

## Stufe 2 (optional): Capacitor – native Extras

Nur sinnvoll, wenn eines dieser Extras gewünscht ist: **Startbildschirm-Widget**, **exakte lokale Alarme**
für Erinnerungen, **Schnelleingabe-Kachel**, Vibration/Haptik in nativer Qualität.

[Capacitor](https://capacitorjs.com) verpackt die vorhandene React-App in eine native Android-App mit
WebView und erlaubt Plugins in Kotlin.

**Aufwand:** mehrere Tage bis Wochen, je nach Extras; danach dauerhafter Pflegeaufwand (Android-Updates,
Gradle, SDK-Versionen).

### Schritte

1. `apps/android` mit `@capacitor/core`, `@capacitor/android` anlegen; Web-Build (`apps/web/dist`) als Inhalt.
   Alternativ `server.url` auf die Live-Seite zeigen lassen – dann wie bei der TWA ohne neue APK für Updates,
   aber Offline-Start nur mit Service Worker.
2. **Anmeldung:** Das Sitzungs-Cookie funktioniert im WebView nur, wenn die App von derselben Domain lädt
   (`server.url`) – sonst Umstellung auf Token-Anmeldung für die App (wie beim Claude-Connector, nur mit
   eigenem Client).
3. **Erinnerungen:** `@capacitor/local-notifications` mit exakten Alarmen; die App plant beim Synchronisieren
   die nächsten Erinnerungen lokal ein. Web-Push bleibt als Rückfall.
   Android 14+: Berechtigung „Wecker & Erinnerungen“ (`SCHEDULE_EXACT_ALARM`) erfragen.
4. **Widget „Heute“:** natives Widget (Kotlin, Glance) liest eine kleine JSON-Zusammenfassung, die die App bei
   jedem Sync in die App-Daten schreibt; Tippen auf eine Aufgabe öffnet sie, Kreis tippen hakt über einen
   kleinen Hintergrund-Aufruf an den Server ab.
5. **Schnelleingabe-Kachel:** `TileService`, öffnet die App direkt mit `?add=1` (gibt es schon).
6. **Build in CI:** GitHub Actions mit Android-SDK; Signierschlüssel als Actions-Secret; APK als Release-Datei.
7. **Updates verteilen:** über GitHub-Releases (privat) oder F-Droid-Repo; App prüft beim Start, ob eine neue
   Version da ist.

### Risiken

- Zwei Welten pflegen (Web + Android-Hülle); jedes Android-Update kann Anpassungen nötig machen.
- Exakte Alarme werden von manchen Herstellern (Xiaomi, Huawei, Samsung-Energiesparen) trotzdem gebremst –
  Hinweis in der App, Do-it von der Akku-Optimierung auszunehmen.
- Das iPad hätte davon nichts; dort bleibt die PWA.

---

## Entscheidungshilfe

- „Ich will einfach ein normales App-Symbol und die App an Freunde schicken können“ → **Stufe 1 (TWA)**.
- „Ich will ein Widget mit meinen heutigen Aufgaben“ oder „Erinnerungen kommen manchmal zu spät“ →
  erst prüfen, ob Do-it in den Akku-Einstellungen von der Optimierung ausgenommen ist; wenn das nicht reicht →
  **Stufe 2 (Capacitor)**.
- Alles andere → **PWA behalten**, das spart Pflegeaufwand.
