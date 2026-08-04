# Abgabe testen — Kurzanleitung

Beide Werkzeuge sprechen dasselbe Backend an: **M10 = SQL-Playground**, **M11 = Modellierungstool**.

## 1. Backend starten
```bash
cp .env.example .env
docker-compose up          # Backend + PostgreSQL + Redis auf http://localhost:3000
# ohne Docker: npm install && npm run dev   (laufende PostgreSQL/Redis vorausgesetzt)
```

## 2. Datenbankschema einspielen (einmalig)
```bash
npm install
npm run migrate
```

## 3. Feste Test-Sessions + Rollen laden (empfohlen)
```bash
docker compose exec -T postgres psql -U postgres -d projekt5 < db/seed-roles.sql
# legt stabile Sessions mit den Nutzern alice / bob / carol / dave an
```

## 4. M10 — SQL-Playground (wird vom Backend ausgeliefert)
Im Browser öffnen (ein Tab je Nutzer):
```
http://localhost:3000/playground.html?session=10111111-1111-1111-1111-111111111111&user=alice
http://localhost:3000/playground.html?session=10111111-1111-1111-1111-111111111111&user=bob
```
→ In einem Tab tippen, im anderen erscheint die Änderung in Echtzeit.

## 5. M11 — Modellierungstool

Das M11-Frontend ist **nicht Teil dieses Repositories**: Es baut auf einem separat gepflegten
Werkzeug auf. Backend-seitig ist die Anbindung vollstaendig vorbereitet (`Y.Map` fuer Diagramme,
Rollen, Live-Events). Die dafuer noetigen Endpunkte und Ereignisse stehen in
[`docs/API-und-Nutzungshandbuch.md`](docs/API-und-Nutzungshandbuch.md).

## 6. Auth-Modi
- **Standard:** Dev-Modus (keine Token-Prüfung, jeder Aufruf = `dev-user`).
- **Mit Rollen/echten Nutzer-IDs:** `npm run mock:auth` starten und `AUTH_SERVICE_URL=http://localhost:4000/validate` setzen (Token = Nutzername, z. B. `alice`).

## Weiterführend
- Bedienung & Endpunkte: `docs/API-und-Nutzungshandbuch.md`
- Anbindung an Projekt 1: `docs/Integrationsleitfaden-Projekt1.md`
- Ordnerstruktur: `docs/Projektstruktur.md`
