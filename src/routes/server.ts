import { createServer as createHttpServer, type Server } from 'node:http';

import express, { type ErrorRequestHandler, type RequestHandler, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';

import { isAllowedOrigin } from '../utils/origin.ts';
import { fail } from './http.ts';

export interface ServerOptions {
  readonly logger: Logger;
  /** The routes of the service. Left out, only the health check answers. */
  readonly api?: Router;
  /** Web origins whose pages may call the routes; left out, every origin may. */
  readonly allowedOrigins?: readonly string[];
}

/** Builds the HTTP server around the routes handed in; the WebSocket gateway attaches to it. */
export function createServer(options: ServerOptions): Server {
  const app = express();

  app.use(helmet());
  app.use(pinoHttp({ logger: options.logger }));
  app.use(allowCrossOrigin(options.allowedOrigins));

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

/** Lets pages on other origins call the routes; answers the preflight before any token is asked for. */
function allowCrossOrigin(allowed?: readonly string[]): RequestHandler {
  return (request, response, next) => {
    // The answer depends on Origin, so a cache must not hand it to another origin.
    response.vary('Origin');

    const origin = request.get('origin');
    if (origin === undefined || !isAllowedOrigin(origin, allowed)) {
      return next();
    }

    response.set('Access-Control-Allow-Origin', origin);
    // Without this the page could not read which change a state reaches.
    response.set('Access-Control-Expose-Headers', 'X-Up-To-Update-Id');

    if (request.method !== 'OPTIONS') {
      return next();
    }
    // A preflight carries no token, so it must not reach requireActor.
    response.set({
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    });
    response.status(204).end();
  };
}

/** Own words for what went wrong reading a body; never the message, which may echo the input. */
const BODY_ERRORS: ReadonlyMap<string, string> = new Map([
  ['entity.parse.failed', 'body is no valid JSON'],
  ['entity.too.large', 'body is too large'],
  ['charset.unsupported', 'body charset is unsupported'],
  ['encoding.unsupported', 'body encoding is unsupported'],
]);

/** A client error keeps its status; anything else is logged and answered with 500. */
const answerError: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    return next(error);
  }
  const status: unknown = error?.status;

  if (typeof status === 'number' && status >= 400 && status < 500) {
    const type: unknown = error?.type;
    const told = typeof type === 'string' ? BODY_ERRORS.get(type) : undefined;
    return fail(response, status, told ?? 'bad request');
  }
  request.log.error({ err: error }, 'request failed');
  fail(response, 500, 'internal');
};
