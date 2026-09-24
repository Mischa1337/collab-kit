/**
 * Starts the service: reads the configuration, readies the database and wires every
 * part together. The only file that knows all the others.
 */

import pino from 'pino';

import { readConfig } from './config.ts';
import { createTokenCheck } from './auth/token.ts';
import { applyDefinitions } from './db/apply.ts';
import { connect } from './db/client.ts';
import { collectionDefinitions } from './db/schemas.ts';
import { createDocumentHub } from './realtime/hub.ts';
import { attachGateway } from './realtime/gateway.ts';
import { createApi } from './routes/index.ts';
import { createServer } from './routes/server.ts';

const config = readConfig();
const log = pino({ level: config.logLevel });

const storage = await connect({ uri: config.mongoUri, database: config.mongoDb });
await applyDefinitions(storage.db, collectionDefinitions);
log.info({ database: config.mongoDb, collections: collectionDefinitions.length }, 'database ready');

const checkToken = createTokenCheck({
  key: config.jwtKey,
  algorithm: config.jwtAlgorithm,
  clockToleranceSeconds: config.jwtClockTolerance,
  actorClaim: config.actorClaim,
  labelClaim: config.labelClaim,
});
const hub = createDocumentHub({ db: storage.db, logger: log });
const server = createServer({
  logger: log,
  api: createApi({ db: storage.db, hub, checkToken, logger: log }),
});
const gateway = attachGateway({ server, db: storage.db, hub, checkToken, logger: log });

server.listen(config.port, () => {
  log.info({ port: config.port }, 'listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');

    // Order matters: connections first, then the server, then the database. The other
    // way round a request could still reach a storage that is already closed.
    void gateway
      .close()
      .then(() => new Promise<void>((resolve) => server.close(() => resolve())))
      .then(() => storage.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          log.error({ error }, 'shutdown failed');
          process.exit(1);
        },
      );
  });
}
