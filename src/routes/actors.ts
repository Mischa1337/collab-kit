import { Router } from 'express';
import type { Db } from 'mongodb';

import { nameableAmong } from '../auth/access.ts';
import { findNames } from '../db/collections/actors.ts';
import { asActorId, asEvery } from '../utils/input.ts';
import { actorOf, fail } from './http.ts';

/** Names to actor keys, so a tool shows people where the service keeps only keys. */
export function actorRoutes(db: Db): Router {
  const routes = Router();

  /** Whom the token names, so a tool need not know which claim holds the key. */
  routes.get('/me', (request, response) => {
    const { actorId, label } = actorOf(request);
    response.json(label === undefined ? { actorId } : { actorId, label });
  });

  /** The stored names of these actors, as far as the token may put a name to them. */
  routes.get('/actors', async (request, response) => {
    const actorIds = asActorIds(request.query['ids']);

    if (actorIds === undefined) {
      return fail(response, 400, 'ids must be actor keys separated by commas');
    }

    // Only the name: when somebody was last seen is nobody else's business.
    const nameable = await nameableAmong(db, actorOf(request), actorIds);
    const found = await findNames(db, nameable);
    response.json(
      found.map(({ _id, label }) =>
        label === undefined ? { actorId: _id } : { actorId: _id, label },
      ),
    );
  });

  return routes;
}

/** Keys separated by commas, each once; an empty one among them is a mistake. */
function asActorIds(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  const actorIds = asEvery(
    raw.split(',').map((part) => part.trim()),
    asActorId,
  );
  return actorIds === undefined ? undefined : [...new Set(actorIds)];
}
