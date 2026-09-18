import pino from 'pino';

import { applyDefinitions } from './db/apply.ts';
import { connect } from './db/client.ts';
import { collectionDefinitions } from './db/schemas.ts';
import { readConfig } from './config.ts';

const config = readConfig();
const log = pino({ level: config.logLevel });

const storage = await connect({ uri: config.mongoUri, database: config.mongoDb });
log.info({ database: config.mongoDb }, 'database connected');

await applyDefinitions(storage.db, collectionDefinitions);
log.info(
  { collections: collectionDefinitions.map((definition) => definition.name) },
  'definitions applied',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    void storage.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
