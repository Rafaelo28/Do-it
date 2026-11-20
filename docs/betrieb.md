# Do-it betreiben – Schritt für Schritt

Diese Anleitung bringt Do-it auf eurem Proxmox-Cluster ins Netz, erreichbar unter **https://do-it.gerda-hilft.de** über einen Cloudflare Tunnel. Am Router muss kein Port geöffnet werden.

```
Handy/iPad/PC ──HTTPS──► Cloudflare ──Tunnel──► VM (Docker): cloudflared → app → PostgreSQL
                                                              worker (Erinnerungen) ──► Push-Dienste
                                                              backup (nachts pg_dump)
```

---

## 1. VM auf Proxmox anlegen

| Einstellung | Wert |
|---|---|
| Betriebssystem | Debian 13 (Netinstall-ISO oder Cloud-Image) |
| CPU / RAM / Disk | 2 vCPU · 4 GB · 30 GB |
| Netzwerk | normales LAN, ausgehend Internet (HTTPS) |
| Optionen | QEMU Guest Agent an, „Start at boot“ an |

Nach der Installation:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y qemu-guest-agent git curl ca-certificates unattended-upgrades
sudo systemctl enable --now qemu-guest-agent
sudo dpkg-reconfigure -plow unattended-upgrades   # automatische Sicherheitsupdates
```

**Docker installieren** (offizielles Repository):

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER   # danach einmal ab- und wieder anmelden
```

Firewall (optional, empfohlen): eingehend nur SSH aus dem Admin-Netz. Die App braucht **keinen** offenen Port, weil der Tunnel nach außen aufgebaut wird.

## 2. Code holen und konfigurieren

```bash
git clone https://github.com/Rafaelo28/Do-it.git ~/do-it
cd ~/do-it/deploy
cp .env.example .env
openssl rand -base64 32        # Ausgabe als POSTGRES_PASSWORD in .env eintragen
nano .env
```

Den `CLOUDFLARE_TUNNEL_TOKEN` gibt es im nächsten Schritt.

## 3. Cloudflare Tunnel einrichten

1. Im Cloudflare-Dashboard **Zero Trust → Networks → Tunnels → Create a tunnel** wählen.
2. Typ **Cloudflared**, Name z. B. `do-it`.
3. Bei der Installationsart **Docker** wählen und aus dem angezeigten Befehl nur das Token kopieren (der lange Text nach `--token`). Ins Feld `CLOUDFLARE_TUNNEL_TOKEN` der `.env` eintragen.
4. Weiter zu **Public Hostname**:
   - Subdomain: `do-it`
   - Domain: `gerda-hilft.de`
   - Service: Typ `HTTP`, URL `app:8080`
5. Speichern.

**Wichtige Einstellungen in der Zone `gerda-hilft.de`:**

| Wo | Einstellung |
|---|---|
| Network | **WebSockets: an** (Standard) |
| Speed → Optimization | **Rocket Loader: aus** (zerstört JavaScript) |
| Scrape Shield | **E-Mail-Adressen verschleiern: aus** (verändert HTML) |
| Caching → Cache Rules | **keine** „Cache Everything“-Regel für `do-it.gerda-hilft.de`. Die App setzt selbst die richtigen Cache-Header. |
| Security → Bots / WAF | Bot Fight Mode darf Claude nicht aussperren: ggf. Ausnahme für `/mcp`, `/oauth/`, `/.well-known/` (siehe [claude.md](claude.md)) |
| Zero Trust → Access | **keine** Access-Anwendung vor die App setzen. Do-it hat einen eigenen Login, und Access würde Service Worker und Push-Aktionen blockieren. |
| SSL/TLS | Modus „Full“ ist nicht nötig, der Tunnel ist bereits verschlüsselt. Standard passt. |

## 4. Starten

```bash
cd ~/do-it/deploy
docker compose up -d --build
docker compose ps                       # alle Dienste "running", app "healthy"
curl http://127.0.0.1:8080/api/health   # {"ok":true,...}
docker compose logs -f cloudflared      # sollte "Registered tunnel connection" zeigen
```

Dann **https://do-it.gerda-hilft.de** öffnen. Beim ersten Aufruf erscheint die **Ersteinrichtung**: Das erste Konto wird Admin.
Damit niemand anderes zuvorkommt, braucht die Ersteinrichtung einen **Einrichtungscode**. Er steht im Log der App:

```bash
docker compose logs app | grep Einrichtungscode
# oder
docker compose exec app node dist/cli.js setup-code
```

Am besten das Konto direkt nach dem ersten Start anlegen. Danach ist der Code verbraucht, und weitere Personen kommen nur noch über Einladungslinks dazu.

## 5. Geräte einrichten

| Gerät | So geht's |
|---|---|
| **Android** (Chrome) | Seite öffnen → Menü (drei Punkte oben rechts) → **App installieren**. In Do-it: Einstellungen → **Benachrichtigungen einschalten** → Test senden. In den Android-Einstellungen für Do-it/Chrome die Akku-Optimierung ausschalten, dann kommen Erinnerungen pünktlicher. |
| **iPad / iPhone** (Safari, ab iPadOS 16.4) | Seite in Safari öffnen → **Teilen** → **Zum Home-Bildschirm**. Do-it **vom Home-Bildschirm** starten → Einstellungen → Benachrichtigungen einschalten. Nur so gibt es Push auf iOS. |
| **Desktop** (Chrome/Edge) | Seite öffnen → Symbol „App installieren“ in der Adressleiste. Benachrichtigungen kommen, solange der Browser läuft (auch im Hintergrund). |

**Claude verbinden** (Zusammenfassungen, Aufgaben per Chat): siehe [claude.md](claude.md).

**Weitere Personen einladen:** Einstellungen → *Neue Person einladen* → Link teilen (gilt 7 Tage, einmalig). Projekte teilt man danach im Projekt über *Projekt-Einstellungen* → *Jemanden einladen*.

## 6. Sicherungen

Drei Ebenen:

1. **Proxmox Backup** der ganzen VM (täglich, im Proxmox-Backup-Job eintragen).
2. **Datenbank-Dump** jede Nacht durch den `backup`-Dienst nach `BACKUP_DIR` (Standard `deploy/backups`). Am besten auf ein NFS-/SMB-Share legen.
   Sofort-Sicherung: `docker compose exec backup /bin/sh /backup.sh now`
3. Eine Kopie **außer Haus** (z. B. rclone/rsync der Dumps auf einen anderen Standort).

**Wiederherstellen** (einmal im Quartal testen):

```bash
cd ~/do-it/deploy
./restore.sh backups/doit_2026-11-20_0215.dump
```

## 7. Updates

```bash
cd ~/do-it/deploy
./update.sh
```

Das Skript sichert zuerst die Datenbank, holt den neuen Code, baut das Image, startet neu und zeigt den Status. Datenbank-Migrationen laufen beim Start automatisch. Die Apps auf den Geräten zeigen danach „Neue Version verfügbar – Neu laden“.

## 8. Wenn etwas nicht geht

| Problem | Prüfen |
|---|---|
| Seite nicht erreichbar | `docker compose logs cloudflared` – Tunnel verbunden? Public Hostname auf `http://app:8080`? |
| „Offline“ in der App, obwohl online | WebSockets in Cloudflare an? `docker compose logs app` |
| Keine Erinnerungen | `curl 127.0.0.1:8080/api/health` → `workerAgeSec` sollte < 60 sein. Sonst `docker compose logs worker`. In der App: Einstellungen → Test senden. |
| Push auf iPad fehlt | Do-it muss vom Home-Bildschirm gestartet sein, nicht aus Safari. |
| Push auf Android verspätet | Akku-Optimierung für Chrome/Do-it ausschalten. |
| Passwort vergessen | `docker compose exec app node dist/cli.js reset-password name@example.org` gibt ein neues Passwort aus. Weitere Befehle: `users`, `make-admin <email>`. |
| Handy mit Authenticator-App verloren | Mit einem der Wiederherstellungscodes anmelden. Ohne Codes: `docker compose exec app node dist/cli.js disable-2fa name@example.org`, danach neu einrichten. |
| Einrichtungscode gesucht | `docker compose exec app node dist/cli.js setup-code` |
| „Zu viele Anfragen“ | Schutz gegen Skripte: höchstens 600 Anfragen pro Minute und IP (`RATE_LIMIT_PER_MIN` in der `.env`), 10 Anmeldeversuche pro Konto in 15 Minuten. Kurz warten. |

## 9. Absicherung

**Was Do-it selbst schon macht:**

| Schutz | Wie |
|---|---|
| Kein offener Port | Der Tunnel baut die Verbindung von innen nach außen auf. Die App lauscht nur auf `127.0.0.1` der VM. |
| Ersteinrichtung | nur mit dem Einrichtungscode aus dem Server-Log (siehe Schritt 4) |
| Passwörter | scrypt-Hashes, mindestens 8 Zeichen, sehr häufige Passwörter („passwort123“, „12345678“ …) werden abgelehnt |
| Zwei-Faktor-Anmeldung | Einstellungen → *Zwei-Faktor-Anmeldung* → mit einer Authenticator-App (Aegis, 2FAS, Google/Microsoft Authenticator). Dazu gibt es 8 Wiederherstellungscodes. |
| Angemeldete Geräte | Einstellungen → *Angemeldete Geräte*: Liste aller Sitzungen, „Alle anderen Geräte abmelden“. Passwort ändern meldet ebenfalls alle anderen Geräte ab. |
| Brute-Force | 10 Anmeldeversuche pro Konto und IP in 15 Minuten, 30 pro IP, 10 falsche Zwei-Faktor-Codes pro Konto. Dazu ein grobes Limit von 600 Anfragen pro Minute und IP. |
| Cookies | `__Host-`-Präfix, `HttpOnly`, `Secure`, `SameSite=Lax`. Schreibende Anfragen nur von der eigenen Adresse (Origin-Prüfung). |
| Browser-Schutz | Content-Security-Policy (nur eigene Skripte), HSTS, `X-Frame-Options: DENY`, `nosniff`, Permissions-Policy (kein Zugriff auf Kamera, Mikrofon, Standort) |
| Container | Läuft als Benutzer `node`, ohne Linux-Capabilities und mit `no-new-privileges`. Logs werden auf 3 × 10 MB begrenzt. |
| Daten | Nächtliche Datenbank-Sicherung. Alte Sitzungen, Codes und Einträge werden automatisch aufgeräumt. |

**Empfohlen in Cloudflare (kostenlos):**

| Wo | Einstellung |
|---|---|
| SSL/TLS → Edge Certificates | **Always Use HTTPS: an**, **Minimum TLS Version: 1.2** |
| Security → WAF → Rate limiting rules | Eine Regel: *URI Path equals* `/api/auth/login`, **5 Anfragen pro 10 Sekunden** je IP, Aktion **Block** für 10 Sekunden. Das ist die eine Regel, die im kostenlosen Tarif enthalten ist. |
| Security → Settings | **Security Level: Medium**, **Browser Integrity Check: an** |
| Security → Bots | Bot Fight Mode nur einschalten, wenn Claude trotzdem verbinden kann. Sonst aus lassen (siehe [claude.md](claude.md)). |
| Security → WAF → Custom rules | Optional, wenn ihr nur in Deutschland seid: *Country not in {Germany}* → **Managed Challenge**. Ausnahmen für `/mcp`, `/oauth/` und `/.well-known/`, weil Claude aus den USA zugreift. |

**Für euch selbst:**

- Ein eigenes, langes Passwort (Passwort-Manager) und Zwei-Faktor-Anmeldung, mindestens für das Admin-Konto.
- Die `.env` enthält das Datenbank-Passwort und das Tunnel-Token: nicht ins Git, nicht weitergeben (`chmod 600 deploy/.env`).
- VM aktuell halten (`unattended-upgrades` aus Schritt 1) und Do-it regelmäßig mit `./update.sh` aktualisieren.
- SSH nur mit Schlüssel, Passwort-Login aus (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).
- Einladungslinks nur direkt an die Person schicken. Sie gelten 7 Tage und nur einmal.

## 10. Entwicklung

```bash
corepack enable
pnpm install
docker compose -f deploy/docker-compose.dev.yml up -d          # Postgres auf localhost:5432
DATABASE_URL=postgres://doit:doit@localhost:5432/doit RUN_WORKER=true pnpm --filter @do-it/server dev
pnpm --filter @do-it/web dev                                    # http://localhost:5173 (leitet /api an :8080 weiter)
pnpm test                                                        # alle Tests (Server-Tests brauchen Postgres)
```

Für den Vite-Dev-Server muss der Server die Origin kennen: `ALLOWED_ORIGINS=http://localhost:5173`.

**Ende-zu-Ende-Test im Browser** (Einrichtung, Einladung, geteiltes Projekt, Live-Sync, Offline-Betrieb): Server mit *leerer* Datenbank und gebauter Web-App starten, dann

```bash
npx playwright install chromium   # einmalig
E2E_URL=http://localhost:8080 pnpm e2e
```
