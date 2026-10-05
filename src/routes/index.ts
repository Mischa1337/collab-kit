import express, { Router } from 'express';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';

import type { Actor } from '../model/actor.ts';
import { requireActor } from '../auth/middleware.ts';
import type { WorkpieceHub } from '../realtime/hub.ts';
import { roomRoutes } from './rooms.ts';
import { groupRoutes } from './groups.ts';
import { grantRoutes } from './grants.ts';
import { workpieceRoutes } from './workpieces.ts';
import { eventRoutes } from './events.ts';
import { commentRoutes } from './comments.ts';
import { taskRoutes } from './tasks.ts';

export interface ApiOptions {
  readonly db: Db;
  readonly hub: WorkpieceHub;
  readonly checkToken: (token: string) => Promise<Actor>;
  readonly logger: Logger;
  /** Called after a route took access away, so open connections are asked again. */
  readonly recheckAccess: () => Promise<void>;
}

/** Every route behind requireActor: who acts comes from the token, never from a body. */
export function createApi(options: ApiOptions): Router {
  const api = Router();

  api.use(
    requireActor(options.checkToken, (error) => {
      options.logger.info({ err: error }, 'token rejected');
    }),
  );
  api.use(express.json({ limit: '1mb' }));

  api.use(roomRoutes(options.db, options.recheckAccess));
  api.use(groupRoutes(options.db, options.recheckAccess));
  api.use(grantRoutes(options.db, options.recheckAccess));
  api.use(workpieceRoutes(options.db, options.hub));
  api.use(eventRoutes(options.db));
  api.use(commentRoutes(options.db));
  api.use(taskRoutes(options.db));

  return api;
}
