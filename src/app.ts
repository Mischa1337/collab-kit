import pino from 'pino';

import { readConfig } from './config.ts';
import { createTokenCheck } from './auth/token.ts';
import { applyDefinitions } from './db/apply.ts';
import { connect } from './db/client.ts';
import { collectionDefinitions } from './db/schemas.ts';
import { attachGateway } from './realtime/gateway.ts';
import { createServer } from './server.ts';

const config = readConfig();
const log = pino({ level: config.logLevel });

const storage = await connect({ uri: config.mongoUri, database: config.mongoDb });
await applyDefinitions(storage.db, collectionDefinitions);
log.info({ database: config.mongoDb, collections: collectionDefinitions.length }, 'database ready');

const server = createServer({ logger: log });
const gateway = attachGateway({
  server,
  db: storage.db,
  checkToken: createTokenCheck({ secret: config.jwtSecret }),
  logger: log,
});

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
