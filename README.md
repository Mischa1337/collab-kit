# Collab Kit

Studienprojekt · Technische Hochschule Mittelhessen, Fachbereich MNI · 2026

**Team:** Michael Albach · Egemen Demir · Silas Teutschländer · Pierre Simon Oyono Essam · Alex Roy Nyamsi Nitchougno

Kollaborativer Backend-Dienst, der aus einem Einzelnutzer-Werkzeug ein Mehrbenutzer-Werkzeug macht: mehrere Nutzer bearbeiten dieselben Inhalte in Echtzeit und nachvollziehbar. Als Testfall dienen der **SQL Playground** und das **Modellierungstool**. Grundlage sind **Yjs-CRDT** + **WebSocket** für konfliktfreie Synchronisation, **PostgreSQL** für die Persistenz und **Redis** als schneller Session-Cache und Pub/Sub.

---

## Was der Dienst kann

- **Echtzeit-Bearbeitung** (SQL-Text und/oder Diagramm-Modell), konfliktfrei über CRDT
- **Rollen & Zugriff** je Session (owner/member/commentator/spectator), durchgesetzt in REST **und** im WebSocket-Schreibpfad
- **Awareness:** fremde Cursor, Autoren-Zuordnung, Change-Feed und semantische Konflikterkennung (Schicht 2)
- **Versionsverlauf** (geteilte + private Stände, Diff, Wiederherstellung) und **privates Arbeitsmodell** mit Veröffentlichen
- **Kommentare** (Threads, Auflösen, @-Erwähnungen) und **Peer-Review** (mehrere Reviewer, gezielte Adressierung)
- **Koordination:** Aufgaben, synchroner Chat, dauerhafte Benachrichtigungen
- **Datenhoheit:** Export von Session- und Nutzerdaten (DSGVO Art. 15)

---

## Schnellstart

```bash
cp .env.example .env
docker-compose up
```

Der Server läuft auf Port `3000`; Node.js, PostgreSQL und Redis starten zusammen.

Das Datenbankschema einmalig einspielen (siehe [Datenbank](#datenbank)):

```bash
npm install
npm run migrate
```

**Ohne Docker (lokale Entwicklung):**

```bash
npm install
npm run dev          # Hot-Reload; setzt laufende PostgreSQL- und Redis-Instanz voraus
```

---

## Umgebungsvariablen

Alle Variablen aus `.env.example` kopieren und anpassen:

| Variable | Beschreibung | Standard |
|---|---|---|
| `PORT` | HTTP- und WebSocket-Port | `3000` |
| `CORS_ORIGIN` | erlaubte Origin für CORS | `http://localhost:5173` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | PostgreSQL-Verbindung | `postgres` / `5432` / `postgres` / — / `projekt5` |
| `REDIS_HOST` / `REDIS_PORT` | Redis-Verbindung | `redis` / `6379` |
| `AUTH_SERVICE_URL` | Token-Validierungs-Endpoint von Projekt 1 | *(leer = Dev-Modus)* |

---

## Betriebsmodi

- **Standalone (Dev):** Ohne `AUTH_SERVICE_URL` entfällt die Token-Prüfung, alle Anfragen gelten als `dev-user`. Für Entwicklung und die eigenständige Nutzung.
- **An Projekt 1 angebunden:** Mit gesetztem `AUTH_SERVICE_URL` wird jeder Aufruf gegen die Auth-Schnittstelle von Projekt 1 validiert. Details: [`docs/funktionsorientiert/Integrationsleitfaden-Projekt1.md`](docs/funktionsorientiert/Integrationsleitfaden-Projekt1.md).

---

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [`docs/API-und-Nutzungshandbuch.md`](docs/API-und-Nutzungshandbuch.md) | Start, Anbindung, Kernabläufe **und** vollständige Endpunkt-/Event-Referenz |
| [`docs/funktionsorientiert/Integrationsleitfaden-Projekt1.md`](docs/funktionsorientiert/Integrationsleitfaden-Projekt1.md) | Ankopplung an die Plattform aus Projekt 1 |
| [`docs/Projektstruktur.md`](docs/Projektstruktur.md) | Aufbau des Repositories |
| [`docs/Meilensteine.md`](docs/Meilensteine.md) | Auflösung der Kürzel M1 bis M23 |
| [`docs/Handbuch.md`](docs/Handbuch.md) | **Vollständiges Projekt-Handbuch**: Architektur, Datenmodell, Abläufe, Betrieb, Hintergrund |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Bekannte offene Punkte und nächste Schritte |
| [`docs/literatur/`](docs/literatur/) | Literaturarbeit: Guide, Anforderungskatalog, Gap-Analyse, Zusammenfassungen |
| [`docs/bilder/`](docs/bilder/) | Architektur- und Ablaufdiagramme |
| [`contracts/be-contract.ts`](contracts/be-contract.ts) | maschinengeprüfte Schnittstellen-Typen (ins Frontend kopieren) |

---

## Technologie-Stack

Node.js 20 / TypeScript · Express + `ws` · Yjs + `y-websocket` · PostgreSQL · Redis · Helmet, Rate-Limiting und Prometheus-Metriken für den Betrieb.

---

## Tests

```bash
npm test               # alle Tests (Jest, einmalig)
npm run test:watch     # Watch-Modus
```

**305 Tests in 27 Suiten.** Kein laufender Docker nötig — PostgreSQL und Redis werden vollständig gemockt; die Tests laufen bei jedem Push (GitHub Actions).

---

## Datenbank

Das Schema liegt als konsolidierte Migration vor (`db/migrations/001_init.sql`, 14 Tabellen). Sie wird **nicht** automatisch beim Container-Start ausgeführt, sondern einmalig angestossen:

```bash
npm run migrate
```

---

## npm-Skripte (Auswahl)

| Skript | Zweck |
|---|---|
| `npm run dev` | Entwicklungsserver mit Hot-Reload |
| `npm run build` / `npm start` | kompilieren / kompiliert starten |
| `npm run migrate` | Datenbankmigration ausführen |
| `npm test` | Testsuite |
| `npm run retention` / `anonymize-user` | DSGVO-Wartungsjobs |

---

## Projektstruktur

```
src/          Backend-Quellcode (services/ je fachlicher Bereich)
db/           Schema, Migration, Wartungsjobs
contracts/    Schnittstellen-Typen fürs Frontend
docs/         Abgabe-Dokumentation
deploy/       Betrieb (nginx, Backup, Betriebshandbuch)
```

Vollständig beschrieben in [`docs/Projektstruktur.md`](docs/Projektstruktur.md).

---

## Stand

Das Backend ist funktional abgeschlossen und durch 305 Tests abgesichert. Die Anbindung der Zielwerkzeuge (SQL-Playground, Modellierungstool) ist protokollseitig vorbereitet, die Auth-Anbindung (M12) als Middleware bereit. Ein Lasttest über 1.000 gleichzeitige WebSocket-Verbindungen wurde bestanden.

---

## Lizenz

Veröffentlicht unter der MIT-Lizenz, siehe [`LICENSE`](LICENSE). Nutzung, Anpassung und Weitergabe sind erlaubt, solange der Copyright-Hinweis erhalten bleibt.
