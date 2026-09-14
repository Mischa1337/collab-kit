# Abgabe testen — Kurzanleitung

Dieses Repository enthält den Backend-Dienst. Die Frontends (SQL-Playground, Modellierungstool)
werden separat gepflegt und sind nicht Teil der Abgabe.

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

## 4. Backend prüfen
```bash
curl http://localhost:3000/health
npm test                   # 27 Suiten, 305 Tests
```
Der Dienst liefert keine eigene Oberfläche aus. Echtzeit-Verhalten lässt sich mit einem
WebSocket-Client gegen `ws://localhost:3000/sync/<session-id>?devUser=alice` prüfen.

## 5. M11 — Modellierungstool

Das M11-Frontend ist **nicht Teil dieses Repositories**: Es baut auf einem separat gepflegten
Werkzeug auf. Backend-seitig ist die Anbindung vollstaendig vorbereitet (`Y.Map` fuer Diagramme,
Rollen, Live-Events). Die dafuer noetigen Endpunkte und Ereignisse stehen in
[`docs/API-und-Nutzungshandbuch.md`](docs/API-und-Nutzungshandbuch.md).

## 6. Auth-Modi
- **Standard:** Dev-Modus (keine Token-Prüfung, jeder Aufruf = `dev-user`).
- **Mit Rollen/echten Nutzer-IDs:** `DEV_ENFORCE_ROLES=true` setzen (`AUTH_SERVICE_URL` bleibt leer). Die Identität kommt dann pro Aufruf mit: REST über den Header `X-Dev-User-Id: alice`, WebSocket über den Query-Parameter `?devUser=alice`. Es gelten die echten Rollen, der Nutzer muss also Mitglied der Session sein (Seed-Nutzer aus `db/seed-roles.sql`).

## Weiterführend
- Bedienung & Endpunkte: `docs/API-und-Nutzungshandbuch.md`
- Anbindung an Projekt 1: `docs/funktionsorientiert/Integrationsleitfaden-Projekt1.md`
- Ordnerstruktur: `docs/Projektstruktur.md`
