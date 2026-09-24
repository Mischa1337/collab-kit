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
| `ACTOR_CLAIM`         | `sub`   | Claim mit der Kennung der Person. Erlaubt sind Text oder eine Zahl                                           |
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

#### Token zum Ausprobieren

```sh
npm run token -- alice "Alice Muster" 15m
```

Das Skript übernimmt `JWT_ALGORITHM`, `ACTOR_CLAIM` und `LABEL_CLAIM` aus der `.env`. Es kann nur
`HS…`-Tokens erzeugen, denn für die anderen Verfahren fehlt dem Dienst der private Schlüssel.
