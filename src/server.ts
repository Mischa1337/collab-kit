import { createServer as createHttpServer, type Server } from 'node:http';

import express, { type ErrorRequestHandler, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';

export interface ServerOptions {
  readonly logger: Logger;
  /** The routes of the service. Left out, only the health check answers. */
  readonly api?: Router;
}

/**
 * Builds the HTTP server. The routes are handed in rather than built here, so this
 * file stays about transport and the API can be mounted and tested on its own.
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

  if (options.api !== undefined) {
    app.use(options.api);
  }

  app.use(failed(options.logger));

  return createHttpServer(app);
}

/**
 * The last word on anything that got through. What went wrong goes to the log and
 * never into the answer: a client that learns the reason learns about the inside.
 */
function failed(logger: Logger): ErrorRequestHandler {
  return (error, _request, response, next) => {
    if (response.headersSent) {
      return next(error);
    }

    logger.error({ error }, 'request failed');
    response.status(500).json({ error: 'internal' });
  };
}
