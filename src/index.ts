import pino from 'pino';

import { readConfig } from './config.ts';

const config = readConfig();
const log = pino({ level: config.logLevel });

log.info(
  { nodeEnv: config.nodeEnv, port: config.port, database: config.mongoDb },
  'configuration loaded, no server yet',
);
