import pino from 'pino';
import { readConfig } from './config.ts';
import { loadKeySet } from './auth/jwks.ts';
import { createTokenCheck } from './auth/token.ts';
import { applyDefinitions } from './db/apply.ts';
import { connect } from './db/client.ts';
import { createActorNotes } from './db/collections/actors.ts';
import { collectionDefinitions } from './db/schemas.ts';
import { createWorkpieceHub, attachGateway } from './realtime/index.ts';
import { createApi } from './routes/index.ts';
import { createServer } from './routes/server.ts';
import { defined } from './utils/optional.ts';

const config = readConfig();
const log = pino({ level: config.logLevel });

// Connect to MongoDB and bring the collection schemas up to date.
const storage = await connect({ uri: config.mongoUri, database: config.mongoDb });
await applyDefinitions(storage.db, collectionDefinitions);
log.info({ database: config.mongoDb, collections: collectionDefinitions.length }, 'database ready');

// Keys come from the set the issuing tool publishes, loaded now, or from the one fixed key.
const tokenKey =
  'jwksUri' in config.jwtKey
    ? await loadKeySet({ uri: config.jwtKey.jwksUri, algorithm: config.jwtAlgorithm, logger: log })
    : config.jwtKey.fixed;
const checkToken = createTokenCheck({
  key: tokenKey,
  algorithm: config.jwtAlgorithm,
  clockToleranceSeconds: config.jwtClockTolerance,
  actorClaim: config.actorClaim,
  labelClaim: config.labelClaim,
  ...defined({ issuer: config.jwtIssuer, audience: config.jwtAudience, top: config.top }),
});
// One memory of the names written, so REST and WebSocket do not each write them again.
const noteActor = createActorNotes(storage.db, log);
// Keeps the open workpieces in memory for real-time work.
const hub = createWorkpieceHub({ db: storage.db, logger: log, noteActor });
const server = createServer({
  logger: log,
  api: createApi({
    db: storage.db,
    hub,
    checkToken,
    logger: log,
    noteActor,
    // The gateway is attached below; it needs this server, and these routes need it.
    recheckAccess: () => gateway.recheck(),
    ...defined({ decisionStates: config.decisionStates }),
  }),
  ...defined({ allowedOrigins: config.allowedOrigins }),
});
// WebSockets share the port of the HTTP server.
const gateway = attachGateway({
  server,
  db: storage.db,
  hub,
  checkToken,
  logger: log,
  ...defined({
    maxMessageBytes: config.maxMessageBytes,
    maxAwarenessBytes: config.maxAwarenessBytes,
    allowedOrigins: config.allowedOrigins,
  }),
});

server.listen(config.port, () => {
  log.info({ port: config.port }, 'listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');

    // Order matters: connections first, then the server, then the database.
    void gateway
      .close()
      .then(() => new Promise<void>((resolve) => server.close(() => resolve())))
      .then(() => storage.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          log.error({ err: error }, 'shutdown failed');
          process.exit(1);
        },
      );
  });
}
