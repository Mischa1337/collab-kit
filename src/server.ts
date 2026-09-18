import { createServer as createHttpServer, type Server } from 'node:http';

import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';

export interface ServerOptions {
  readonly logger: Logger;
}

/**
 * Builds the HTTP server. It carries no routes of the service yet: those are designed
 * once the connecting client exists, so they answer a real need instead of a guess.
 * The WebSocket gateway attaches to the returned server, not to Express.
 */
export function createServer(options: ServerOptions): Server {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(pinoHttp({ logger: options.logger }));

  // Liveness only: it answers whether the process runs, not whether it can work.
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  return createHttpServer(app);
}
