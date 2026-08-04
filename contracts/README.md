# contracts/ — geteilter Schnittstellen-Vertrag (Backend ↔ Frontend)

Dieser Ordner enthält den **maschinengeprüften Vertrag** zwischen Backend und Frontend als TypeScript-Typen.

## `be-contract.ts`
Reine **Typ-Datei** (selbst-enthalten, keine Imports) mit allen Formen, die über die Schnittstelle laufen:
Rollen, Modell-Typen (M11), Awareness/Schicht-2, History/Stände, Peer Review, Kommentare, Entwurf, Aufgaben, Benachrichtigungen, das `WSEvent`-Union und eine REST-Endpunkt-Kurzreferenz.

- **Quelle der Wahrheit ist das Backend.** Ändert sich die API, wird **diese Datei** aktualisiert.
- Enthält fast nur Typen (kompilieren weg) + wenige `const`s (`MODEL`, `SESSION_MANUAL_LIMIT`, `PERSONAL_MANUAL_LIMIT`).
- Liegt **außerhalb** von `src/` → wird von Build/Lint des Backends **nicht** erfasst.

## So nutzt das Frontend den Vertrag

Das FE ist ein eigenes Projekt → **Datei ins FE-Repo kopieren** und dort importieren:

```bash
# im FE-Repo, z. B.:
cp ../backend/contracts/be-contract.ts src/types/be-contract.ts
```
```ts
import type { ReviewAggregate, WSEvent, SessionRole } from './types/be-contract';
import { SESSION_MANUAL_LIMIT } from './types/be-contract';

const rev = (await (await fetch(`/api/reviews/${id}`, { headers })).json()) as ReviewAggregate;
const ev  = JSON.parse(msg.data) as WSEvent;     // discriminated union über `type`
```

**Optional** ein Sync-Skript in der FE-`package.json`, damit das Kopieren nicht vergessen wird:
```json
{ "scripts": { "sync:contract": "cp ../backend/contracts/be-contract.ts src/types/be-contract.ts" } }
```

> Bei Backend-Änderungen: `be-contract.ts` hier aktualisieren → im FE neu kopieren → der TypeScript-Compiler zeigt die betroffenen Stellen an. Das ist der Sinn des Vertrags.

## Vorgehen / Erklärung
Wie man die einzelnen Tools verdrahtet (Ablauf + Pseudocode), steht im
**[API- und Nutzungshandbuch](../docs/API-und-Nutzungshandbuch.md)**.
