# collab-kit

## Setup

### Token des anbindenden Werkzeugs

Der Dienst stellt keine Tokens aus. Er prüft das JWT, das das anbindende Werkzeug ausstellt,
und liest daraus, wer handelt. Wie das Token aufgebaut ist, wird pro Instanz in der `.env`
eingestellt, nie pro Anfrage. Die Vorlage ist `.env.example`:

```sh
cp .env.example .env
```

| Variable              | Vorgabe | Bedeutung                                                                                                    |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `JWT_ALGORITHM`       | `HS256` | Verfahren, mit dem das Werkzeug signiert: `HS256/384/512`, `RS256/384/512`, `PS256/384/512`, `ES256/384/512` |
| `JWT_SECRET`          | keine   | Gemeinsames Geheimnis mit dem Werkzeug. Pflicht bei `HS…`                                                    |
| `JWT_PUBLIC_KEY`      | keine   | Öffentlicher Schlüssel des Werkzeugs als PEM. Pflicht bei `RS…`, `PS…` und `ES…`                             |
| `ACTOR_CLAIM`         | `sub`   | Claim mit der Kennung der Person, Text oder Zahl. Eindeutig und dauerhaft, keine E-Mail, kein Benutzername   |
| `LABEL_CLAIM`         | `name`  | Claim mit dem Anzeigenamen. Darf im Token fehlen                                                             |
| `JWT_CLOCK_TOLERANCE` | `5`     | Sekunden, die ein abgelaufenes Token noch gilt, um Uhrenabweichungen auszugleichen. `0` heißt streng         |

Ein leerer Wert gilt als nicht gesetzt, dann greift die Vorgabe. Ein ungültiger Wert oder ein
fehlender Schlüssel verhindert den Start, die Ursache steht in der Fehlermeldung.

**Werkzeug nach Standard** (RFC 7519, OpenID Connect): Nur `JWT_SECRET` setzen.

**Werkzeug mit eigenen Claims**, zum Beispiel Kennung in `uid` und Name in `displayName`:

```sh
ACTOR_CLAIM=uid
LABEL_CLAIM=displayName
```

**Werkzeug mit Schlüsselpaar**: Der Dienst bekommt nur den öffentlichen Schlüssel, der private
bleibt beim Werkzeug. Zeilenumbrüche im PEM werden in doppelten Anführungszeichen als `\n`
geschrieben. `JWT_SECRET` wird dann nicht gebraucht.

```sh
JWT_ALGORITHM=RS256
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...\n-----END PUBLIC KEY-----"
```

Wie lange ein Token gilt, entscheidet das Werkzeug über `exp`. Der Dienst gleicht dabei nur
Uhrenabweichungen bis `JWT_CLOCK_TOLERANCE` aus. Diese Toleranz legt der Betreiber fest, nie
der Client.

#### Token mitschicken

- HTTP: Header `Authorization: Bearer <token>`
- WebSocket: als Subprotokolle `['bearer', <token>]`

Jede Ablehnung beantwortet der Dienst gleich mit `401`. Den Grund schreibt er nur ins Log.

## Betrieb und Grenzen

### Genau ein Prozess

Der Dienst hält jedes geöffnete Werkstück im Speicher des Prozesses, der es geöffnet hat. Laufen
zwei Instanzen gegen dieselbe Datenbank, arbeiten Personen auf verschiedenen Instanzen an
getrennten Ständen. Gespeichert wird alles, aber sie sehen sich nicht live, und die Faltung der
einen Instanz scheitert an der der anderen. Deshalb:

- immer genau eine Instanz,
- beim Update erst die alte stoppen, dann die neue starten (bei `docker compose up -d` ist das
  so),
- beim Stoppen wartet der Dienst höchstens 5 s auf jeden Client und trennt dann hart. Die Frist,
  die die Plattform zum Beenden gibt, sollte darüber liegen (Docker: 10 s).

### Größen

| Variable              | Vorgabe | Bedeutung                                                                                                                      |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `MAX_MESSAGE_BYTES`   | 8 MiB   | Größte Nachricht eines Clients, höchstens 15 MiB, weil MongoDB eine Änderung in einem Dokument bis 16 MiB ablegt. Größer: 1009 |
| `MAX_AWARENESS_BYTES` | 64 KiB  | Größter Awareness-Eintrag (Cursor, Auswahl, Name). Er geht alle 15 s an alle. Größer: 1009                                     |

Zur Einordnung: 50 000 Tastendrücke ergeben rund 1 MB Änderungen und 250 KB gefalteten Stand.

### Herkunft der Verbindungen

`ALLOWED_ORIGINS` legt fest, von welchen Webseiten aus ein Browser den Socket öffnen und die
Routen aufrufen darf, durch Komma getrennt und so, wie der Browser sie schickt:
`https://tool.example`, ohne Pfad und ohne Schrägstrich am Ende. Leer heißt: von überall. Beim
Socket bekommt andere Herkunft 403. Bei den Routen bekommt sie keine CORS-Header, der Browser gibt
ihr die Antwort also nicht heraus. Liegt das Werkzeug unter derselben Origin wie der Dienst, spielt
CORS keine Rolle. Viel Schutz bringt die Liste nicht, denn der Token steckt nicht in einem Cookie,
eine fremde Seite hat ihn also gar nicht.

### Uhr

Änderungen werden nach ihrer `_id` geordnet, und die beginnt mit der Uhrzeit in Sekunden. Springt
die Uhr des Servers um eine Sekunde oder mehr zurück, stimmt die Reihenfolge nicht mehr: `since`,
`at` und das Laden nach der Faltung können eine Änderung dann falsch einordnen. Verloren geht sie
nur, wenn der Prozess abstürzt, bevor die nächste Faltung sie mitschreibt. Die Uhr sollte deshalb
über NTP langsam nachgeführt werden, statt zu springen.

### Eine Änderung, die sich nicht anwenden lässt

Beim Öffnen wendet der Dienst jede gespeicherte Änderung an. Lässt sich eine nicht anwenden, etwa
weil jemand in der Datenbank von Hand etwas geändert hat, kann niemand das Werkstück mehr öffnen.
Das Log nennt dann die `_id` der Zeile in `updates` oder die Faltung des Werkstücks. Die Zeile
einfach zu löschen verliert diese Änderung und alles, was darauf aufbaut.

### Urheber einer Änderung

Der Dienst vergibt den Urheber nach der Verbindung, die eine Änderung liefert. Die Yjs-Bytes
selbst kennen nur eine Client-Nummer, keine Person. Im Normalfall ist das die Person, die getippt
hat. Nur in einem Sonderfall nicht: Scheitert das Speichern, trennt der Dienst alle Verbindungen
des Werkstücks (1011) und lässt nachliefern, was fehlt. Hat jemand das Werkstück genau in den
Millisekunden davor geöffnet, bekam er die ungespeicherte Änderung schon mit. Liefert er sie zuerst
nach, steht sie unter seinem Namen.
