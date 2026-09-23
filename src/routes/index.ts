import express, { Router } from 'express';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';

import type { Actor } from '../actor.ts';
import { requireActor } from '../auth/middleware.ts';
import type { DocumentHub } from '../realtime/hub.ts';
import { documentRoutes } from './documents.ts';
import { eventRoutes } from './events.ts';
import { groupRoutes } from './groups.ts';
import { roomRoutes } from './rooms.ts';

export interface ApiOptions {
  readonly db: Db;
  readonly hub: DocumentHub;
  readonly checkToken: (token: string) => Actor;
  readonly logger: Logger;
}

/**
 * Every route of the service, all behind the same guard. Nothing in here takes an
 * actor key from a body: who is acting comes from the token and from nowhere else.
 */
export function createApi(options: ApiOptions): Router {
  const api = Router();

  api.use(express.json({ limit: '1mb' }));
  api.use(
    requireActor(options.checkToken, (error) => {
      options.logger.info({ error }, 'token rejected');
    }),
  );

  api.use(roomRoutes(options.db));
  api.use(groupRoutes(options.db));
  api.use(documentRoutes(options.db, options.hub));
  api.use(eventRoutes(options.db));

  return api;
}
