import { createServer as createHttpServer, type Server } from 'node:http';

import express, { type ErrorRequestHandler, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';

import { fail } from './http.ts';

export interface ServerOptions {
  readonly logger: Logger;
  /** The routes of the service. Left out, only the health check answers. */
  readonly api?: Router;
}

/** Builds the HTTP server around the routes handed in; the WebSocket gateway attaches to it. */
export function createServer(options: ServerOptions): Server {
  const app = express();

  app.use(helmet());
  app.use(pinoHttp({ logger: options.logger }));

  // Liveness only: it answers whether the process runs, not whether it can work.
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  if (options.api !== undefined) {
    app.use(options.api);
  }

  app.use((_request, response) => fail(response, 404, 'unknown route'));
  app.use(answerError);

  return createHttpServer(app);
}

/** A client error keeps its status; anything else is logged and answered with 500. */
const answerError: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    return next(error);
  }
  const status: unknown = error?.status;

  if (typeof status === 'number' && status >= 400 && status < 500) {
    return fail(response, status, 'bad request');
  }
  request.log.error({ err: error }, 'request failed');
  fail(response, 500, 'internal');
};
