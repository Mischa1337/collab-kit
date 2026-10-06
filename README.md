# collab-kit

Ein Backend-Dienst ohne eigene Oberfläche, der Werkzeuge für Einzelne gemeinsam nutzbar macht. Er
unterstützt beide Arten der Zusammenarbeit: **kollaborativ**, wenn mehrere gleichzeitig am selben
Werkstück arbeiten, und **kooperativ**, wenn Arbeit in Aufgaben zerlegt, zugewiesen und wieder
zusammengeführt wird.

Der Dienst ist inhaltsblind. Er kennt kein Fachgebiet und kein Dateiformat, beides bringt das
anbindende Werkzeug mit. Personen führt er nicht selbst, er liest sie aus dem signierten Token des
Werkzeugs. Jedes Werkzeug bekommt eine eigene Instanz. Echtzeit läuft über Yjs und WebSocket,
gespeichert wird in MongoDB.

## Rechte

Der Dienst kennt sechs feste Rechte: `see`, `speak`, `edit`, `plan`, `decide` und `manage`. Damit
regelt er, wer was sehen, kommentieren, bearbeiten, planen, entscheiden und verwalten darf. Wer sie
wo bekommt, legt das anbindende Werkzeug fest.

## Token

Der Dienst stellt keine Token aus. Er prüft das JWT des anbindenden Werkzeugs und liest daraus, wer
handelt. Eingestellt wird das pro Instanz in der `.env` (Vorlage: `.env.example`), nie pro Anfrage.

| Variable              | Vorgabe | Bedeutung                                                                                                     |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `JWT_ALGORITHM`       | `RS256` | Verfahren, mit dem das Werkzeug signiert: `HS256/384/512`, `RS256/384/512`, `PS256/384/512`, `ES256/384/512`  |
| `JWT_SECRET`          | keine   | Gemeinsames Geheimnis mit dem Werkzeug. Pflicht bei `HS…`                                                     |
| `JWT_PUBLIC_KEY`      | keine   | Öffentlicher Schlüssel des Werkzeugs als PEM. Bei `RS…`, `PS…` und `ES…` dies oder `JWT_JWKS_URI`             |
| `JWT_JWKS_URI`        | keine   | Adresse, unter der das Werkzeug seine öffentlichen Schlüssel als JWKS veröffentlicht                          |
| `JWT_ISSUER`          | keine   | Erwarteter Aussteller `iss`. Leer heißt: nicht geprüft                                                        |
| `JWT_AUDIENCE`        | keine   | Erwartete Empfänger `aud`, durch Komma getrennt, einer muss passen. Leer heißt: nicht geprüft                 |
| `ACTOR_CLAIM`         | `sub`   | Claim mit der Kennung der Person, Text oder Zahl. Eindeutig und dauerhaft, keine E-Mail, kein Benutzername    |
| `LABEL_CLAIM`         | `name`  | Claim mit dem Anzeigenamen. Darf im Token fehlen                                                              |
| `TOP_CLAIM`           | keine   | Claim, der sagt, wer ganz oben steht und überall alles darf. Nur zusammen mit `TOP_VALUES`                    |
| `TOP_VALUES`          | keine   | Werte in `TOP_CLAIM`, die ganz oben zählen, durch Komma getrennt. Leer heißt: niemand, nur Grants entscheiden |
| `JWT_CLOCK_TOLERANCE` | `5`     | Sekunden, die ein abgelaufenes Token noch gilt, um Uhrenabweichungen auszugleichen. `0` heißt streng          |

Ein leerer Wert gilt als nicht gesetzt. Ein ungültiger Wert oder ein fehlender Schlüssel verhindert
den Start, die Ursache steht in der Fehlermeldung. Wie lange ein Token gilt, entscheidet das
Werkzeug über `exp`.

Bei einem Schlüsselpaar bekommt der Dienst nur den öffentlichen Schlüssel, Zeilenumbrüche im PEM
werden als `\n` geschrieben:

```sh
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...\n-----END PUBLIC KEY-----"
```

Veröffentlicht das Werkzeug seine Schlüssel als JWKS, holt der Dienst sie selbst. Er lädt sie beim
Start, ein nicht erreichbarer Aussteller verhindert den Start. Später lädt er neu, wenn ein Token
einen unbekannten `kid` nennt oder die Schlüssel älter als zehn Minuten sind, höchstens einmal pro
Minute. Fällt der Aussteller dabei aus, gelten die bekannten Schlüssel weiter.

Signiert ein Aussteller Token für mehrere Anwendungen mit demselben Schlüssel, gehören `iss` und
`aud` dazu. Sonst gilt auch ein Token, das für eine andere Anwendung ausgestellt wurde:

```sh
JWT_JWKS_URI=https://fbs.example/oauth2/jwks
JWT_ISSUER=https://fbs.example
JWT_AUDIENCE=fbs-web-shell
```

Für selbst signierte Testtoken genügt ein gemeinsames Geheimnis:

```sh
JWT_ALGORITHM=HS256
JWT_SECRET=ein-langes-zufaelliges-geheimnis
```

### Token mitschicken

- HTTP: Header `Authorization: Bearer <token>`
- WebSocket: als Subprotokolle `['bearer', <token>]`

Jede Ablehnung beantwortet der Dienst gleich mit `401`. Den Grund schreibt er nur ins Log.

## Betrieb und Grenzen

### Genau ein Prozess

Der Dienst hält jedes geöffnete Werkstück im Speicher seines Prozesses. Zwei Instanzen gegen
dieselbe Datenbank sehen sich nicht live und stören sich beim Falten. Deshalb:

- immer genau eine Instanz,
- beim Update erst die alte stoppen, dann die neue starten,
- beim Stoppen wartet der Dienst höchstens 5 s auf jeden Client. Die Frist, die die Plattform zum
  Beenden gibt, sollte darüber liegen (Docker: 10 s).

### Größen

| Variable              | Vorgabe | Bedeutung                                                                                                                      |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `MAX_MESSAGE_BYTES`   | 8 MiB   | Größte Nachricht eines Clients, höchstens 15 MiB, weil MongoDB eine Änderung in einem Dokument bis 16 MiB ablegt. Größer: 1009 |
| `MAX_AWARENESS_BYTES` | 64 KiB  | Größter Awareness-Eintrag (Cursor, Auswahl, Name). Er geht alle 15 s an alle. Größer: 1009                                     |

Zur Einordnung: 50 000 Tastendrücke ergeben rund 1 MB Änderungen und 250 KB gefalteten Stand.

### Herkunft der Verbindungen

`ALLOWED_ORIGINS` listet die Webseiten, von denen aus ein Browser den Socket öffnen und die Routen
aufrufen darf: durch Komma getrennt, ohne Pfad und ohne `/` am Ende, etwa `https://tool.example`.
Leer heißt: von überall. Andere Herkunft bekommt am Socket `403` und bei den Routen keine
CORS-Header.

### Entscheidungen

`DECISION_STATES` nennt die Zustände von Aufgaben und Kommentaren, die eine Entscheidung sind,
durch Komma getrennt, etwa `accepted,rejected`. Einen davon setzt nur, wer das Recht `decide` hat.
Welche Wörter das sind, bestimmt das Werkzeug, der Dienst kennt ihre Bedeutung nicht. Leer heißt:
keiner.

### Bekannte Grenzen

- **Uhr:** Änderungen sind nach der Zeit in ihrer `_id` geordnet. Die Serveruhr sollte deshalb über
  NTP nachgeführt werden, statt zu springen.
- **Nicht anwendbare Änderung:** Lässt sich eine gespeicherte Änderung nicht anwenden, etwa nach
  einem Eingriff von Hand in die Datenbank, öffnet das Werkstück nicht mehr. Das Log nennt die
  `_id` der Zeile. Sie zu löschen verliert diese Änderung und alles, was darauf aufbaut.
- **Urheber:** Als Urheber einer Änderung gilt, wessen Verbindung sie liefert. Nur wenn das
  Speichern scheitert und nachgeliefert wird, kann eine Änderung unter fremdem Namen stehen.
