## Betriebshandbuch

## 1. Einleitung

Dieses Dokument beschreibt die Inbetriebnahme und den Betrieb der Co-Working-Schnittstelle für kollaboratives Arbeiten in Lernumgebungen.

Das System ermöglicht die gemeinsame Bearbeitung von Dokumenten durch mehrere Nutzer und stellt Funktionen für Versionsverwaltung, Kommentare, Peer Reviews, Benachrichtigungen und Echtzeit-Synchronisation bereit.

Das Handbuch richtet sich an Administratoren und technische Mitarbeiter, die das System produktiv betreiben möchten.

---

## 2. Systemübersicht

Das System besteht aus folgenden Komponenten:

| Komponente        | Beschreibung                           |
| ----------------- | -------------------------------------- |
| Backend (Node.js) | REST-API und WebSocket-Server          |
| PostgreSQL        | Persistente Datenspeicherung           |
| Redis             | Cache, Pub/Sub und aktive Sitzungen    |
| Yjs               | Kollaborative Echtzeit-Synchronisation |
| Docker Compose    | Bereitstellung der Services            |

Die Anwendung stellt REST-Endpunkte sowie WebSocket-Verbindungen für die Zusammenarbeit mehrerer Nutzer bereit.

---

## 3. Voraussetzungen

Für den Betrieb werden folgende Komponenten benötigt:

* Docker
* Docker Compose
* Linux-Server oder vergleichbare Umgebung
* Netzwerkzugriff auf den Server
* TLS-Zertifikat für HTTPS/WSS (empfohlen)

---

## 4. Pflicht-Konfiguration

Vor dem ersten Start müssen die Produktionsvariablen gesetzt werden.

Datei:

.env.prod

Pflichtvariablen:

| Variable         | Beschreibung                             |
| ---------------- | ---------------------------------------- |
| DB_PASSWORD      | Passwort der PostgreSQL-Datenbank        |
| REDIS_PASSWORD   | Passwort für Redis                       |
| CORS_ORIGIN      | Erlaubte Herkunft der Frontend-Anwendung |
| AUTH_SERVICE_URL | URL des Authentifizierungsdienstes       |
| METRICS_TOKEN    | Geheimes Token zum Schutz von `/metrics` (empfohlen) |

> **Hinweis (Fail-Fast):** In Produktion (`NODE_ENV=production`) **erzwingt** die Anwendung das Setzen von `CORS_ORIGIN` **und** `AUTH_SERVICE_URL` — fehlt eine der beiden, startet der Server bewusst **nicht** (verhindert versehentlich offene/ungeschützte Instanzen).

---

## 5. Starten des Systems

### 5.1 Produktionsumgebung vorbereiten

Zunächst muss die Produktionskonfiguration erstellt werden:

```bash
cp .env.prod.example .env.prod
```

Anschließend müssen alle Pflichtvariablen in der Datei `.env.prod` gesetzt werden.

### 5.2 System starten

```bash
docker compose -f docker-compose.prod.yml up -d
```

Dieser Befehl startet:

* Backend-Service
* PostgreSQL-Datenbank
* Redis-Server

Die Datenbankmigrationen laufen **nicht** automatisch; sie werden einmalig per `npm run migrate` eingespielt.

### 5.3 Status prüfen

```bash
docker compose ps
```

Alle Container sollten den Status `Up` besitzen.

---

## 6. Stoppen des Systems

Das System kann mit folgendem Befehl gestoppt werden:

```bash
docker compose -f docker-compose.prod.yml down
```

Beim Herunterfahren werden offene Verbindungen kontrolliert geschlossen.

Die Anwendung unterstützt einen Graceful Shutdown für:

* WebSocket-Verbindungen
* HTTP-Server
* PostgreSQL-Verbindungen
* Redis-Verbindungen

---

## 7. Health-Check

Nach dem Start sollte geprüft werden, ob die Anwendung erreichbar ist.

```bash
curl http://localhost:3000/health
```

Erwartete Antwort:

```json
{
  "status": "ok"
}
```

Der Health-Endpunkt dient außerdem zur Überwachung durch Reverse-Proxys oder Monitoring-Systeme.

---

## 8. Tests

Die Test-Suite kann lokal ausgeführt werden:

```bash
npm test
```

Aktueller Stand:

* 9 Test-Suiten
* 111 automatisierte Tests

Die Tests benötigen keine Docker-Container, da externe Komponenten gemockt werden.

---

## 9. Reverse Proxy und TLS

Für den Produktivbetrieb wird ein Reverse Proxy empfohlen.

Der Reverse Proxy übernimmt:

* HTTPS-Verschlüsselung (TLS)
* Weiterleitung von REST-Anfragen
* Weiterleitung von WebSocket-Verbindungen
* Bereitstellung einer zentralen Domain

Beispiel:

```text
Internet
   ↓
Nginx
   ↓
Backend (Port 3000)
```

Für WebSocket-Verbindungen muss das HTTP-Upgrade korrekt weitergeleitet werden.

Die Referenzkonfiguration befindet sich in `deploy/nginx.conf` und ist als **optionaler** Compose-Service (Profil `proxy`) eingebunden.

### 9.1 Proxy mit TLS starten

```bash
docker compose -f docker-compose.prod.yml --profile proxy up -d
```

Ohne `--profile proxy` starten nur App, PostgreSQL und Redis (z. B. zum Testen). Mit dem Profil kommt nginx (Ports 80/443) hinzu und terminiert TLS.

### 9.2 TLS-Zertifikat (Let's Encrypt)

Vor dem ersten Proxy-Start ein Zertifikat erzeugen (certbot auf dem Host, einmalig):

```bash
# Port 80 muss frei/erreichbar sein
certbot certonly --standalone -d coworking.example.org
```

Die Zertifikate landen unter `/etc/letsencrypt` und werden vom nginx-Container schreibgeschützt eingebunden. Verlängerung via `certbot renew` (Cron); die ACME-HTTP-01-Challenge ist über `/.well-known/acme-challenge/` vorbereitet.

### 9.3 Schutz von `/metrics` (Zusammenspiel M19 ↔ M20)

`/metrics` enthält interne Betriebsdaten und ist **doppelt** geschützt:

* **Proxy (M19):** `location = /metrics { deny all; }` — von außen über HTTPS **nicht** erreichbar.
* **App (M20):** verlangt zusätzlich das `METRICS_TOKEN` (Bearer-Header oder `?token=`). Ohne gesetztes Token greift ein Localhost-Only-Fallback (nur Entwicklung).

**Prometheus** scrapt daher **intern** direkt `app:3000/metrics` mit dem Token, **nicht** über den Proxy. Beispiel-Scrape-Config:

```yaml
scrape_configs:
  - job_name: 'coworking'
    metrics_path: /metrics
    authorization:
      credentials: '${METRICS_TOKEN}'
    static_configs:
      - targets: ['app:3000']
```

`/health` und `/ready` bleiben für Container-/Proxy-Healthchecks erreichbar (kein sensibler Inhalt).

---

## 9b. Horizontale Skalierung

Mehrere App-Instanzen teilen sich Zustand über **Redis Pub/Sub** — Broadcasts erreichen alle Instanzen:

```bash
docker compose -f docker-compose.prod.yml up -d --scale app=3
```

> **Offener Punkt (→ Meilenstein M22):** Beim Start bereinigt jede Instanz globale Präsenz-Keys (`session:*:users`). Im **Mehr-Instanz**-Betrieb kann das die User-Sets anderer Instanzen löschen (bekannte Race-Condition). Bis M22 (Pro-Instanz-Cleanup + Lasttest) **eine** App-Instanz betreiben oder den Startup-Cleanup deaktivieren.

---

## 10. Go-Live-Checkliste

Vor der Produktivsetzung sollten folgende Punkte geprüft werden:

* Docker installiert
* Docker Compose installiert
* .env.prod erstellt
* DB_PASSWORD gesetzt
* REDIS_PASSWORD gesetzt
* CORS_ORIGIN gesetzt
* AUTH_SERVICE_URL gesetzt
* METRICS_TOKEN gesetzt
* Datenbank erreichbar
* Redis erreichbar
* Anwendung gestartet
* Health-Endpunkt (`/health`) erfolgreich getestet
* Readiness-Endpunkt (`/ready`) liefert 200
* TLS-Zertifikat (Let's Encrypt) erzeugt
* Reverse Proxy via `--profile proxy` gestartet
* `/metrics` von außen geblockt (403), intern mit Token erreichbar
* WebSocket-Verbindung (WSS) getestet

---

## 11. Bekannte Hinweise

### TLS

Die Anwendung unterstützt HTTPS und WSS über einen vorgeschalteten Reverse Proxy.

### Authentifizierung

Für den Produktivbetrieb muss ein Authentifizierungsdienst über AUTH_SERVICE_URL angebunden werden. Ist die Variable in Produktion nicht gesetzt, **startet der Server nicht** (Fail-Fast) — andernfalls liefe die API ungeschützt mit einem Fallback-Nutzer.

### Logging

Bei Verwendung von Query-Parametern für Tokens sollte geprüft werden, ob diese durch den Reverse Proxy protokolliert werden.

### Wartung

Datenbankmigrationen werden einmalig per `npm run migrate` eingespielt, nicht automatisch beim Start.

Die Anwendung unterstützt einen Graceful Shutdown für HTTP-, WebSocket-, PostgreSQL- und Redis-Verbindungen.

