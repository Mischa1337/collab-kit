# collab-kit

A backend service that makes tools built for one person usable together. Its core has no user
interface, an optional element for managing rooms, groups and rights comes along. It supports both
kinds of working together: **collaborative**, when several people work on the same workpiece at
the same time, and **cooperative**, when work is split into tasks, assigned and brought back
together.

The service is content-blind. It knows no subject and no file format, the docking tool brings
both. It does not manage identities, it reads them from the tool's signed token. Every tool gets
an instance of its own. Real-time editing runs on Yjs over WebSocket, data is stored in MongoDB.

## Rights

The service knows six fixed rights: `see`, `speak`, `edit`, `plan`, `decide` and `manage`. With
them it controls who may see, comment, edit, plan, decide and manage what.

Rights go to groups through grants. A grant gives a group rights at one place, such as a room or a
workpiece, and everything below it. Without a place it holds in the whole instance. A grant may
also make its members write anonymously there, others then see a pseudonym. Which group gets which
rights where is up to the docking tool.

## Token

The service issues no tokens. It verifies the JWT the docking tool sends with every request, as
`Authorization: Bearer <token>` over HTTP or as WebSocket subprotocols `['bearer', <token>]`, and
reads from it who is acting. An open WebSocket closes with 4401 once its token expires, unless the
client sends a new one, which the client library does on its own. How the service checks the token
(algorithm, key or JWKS, issuer, audience, claims) is set per instance in `.env`, and
`.env.example` describes every variable.

## Client library

A tool in the browser loads the library from the service itself, so it always fits this instance.
It opens sessions at workpieces and calls every route. It brings Yjs along, the tool needs none of
its own:

```js
const { createCollabKitApi } = await import('https://ck.example/client/v1.js');
const ck = createCollabKitApi({ url: 'https://ck.example', getToken });
```

`/client/v1.js`, `/client/v1.d.ts` with the types and `/client/manage-v1.js` come without a token,
for every page that `ALLOWED_ORIGINS` allows.

`manage-v1.js` adds `<ck-management>`, an optional element for rooms, groups and rights. It brings
Lit along and calls CK only through the `ck` it is given:

```js
await import('https://ck.example/client/manage-v1.js');
document.querySelector('ck-management').ck = ck;
```

## Operation and limits

The service keeps every open workpiece in the memory of its process. Two instances against the
same database do not see each other live and get in each other's way when compacting stored
changes. Therefore:

- always exactly one instance,
- on an update, stop the old one first, then start the new one,
- on stop the service waits at most 5 s for each client, so the platform should allow more time to
  shut down (Docker: 10 s).

Message sizes, the web origins allowed to connect, and which states of tasks and comments count as
a decision are set in `.env` as well, see `.env.example`.

Known limits:

- **Clock:** changes are ordered by the time in their `_id`. The server clock should therefore be
  kept in step through NTP instead of jumping.
- **Change that cannot be applied:** if a stored change cannot be applied, e.g. after a manual edit
  of the database, the workpiece no longer opens. The log names the `_id` of the row. Deleting it
  loses this change and everything built on it.
- **Author:** the author of a change is whoever's connection delivers it. Only when storing fails
  and is retried can a change stand under someone else's name.

## Development

Needs Node.js 24 and Docker.

```sh
cp .env.example .env   # then set the token variables
npm ci
npm run db:up          # MongoDB as a single-node replica set on port 24203
npm run dev            # the service on port 24202, restarts on changes
```

`npm test` runs the unit tests, `npm run test:integration` the integration tests against the
database from `.env`. These empty the database named in `MONGODB_DB`, so point them at one of their
own, e.g. `MONGODB_DB=collab_kit_test npm run test:integration`. The CI also runs `npm run lint`,
`npm run format:check` and `npm run typecheck`.

## License

collab-kit is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). It may be used,
changed and passed on for noncommercial purposes, including by universities and other educational
and research institutions. Commercial use is not permitted.

Because it rules out commercial use, this is a source-available license rather than an
OSI-approved open-source license.
