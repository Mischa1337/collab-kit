import { Router } from 'express';
import type { Db } from 'mongodb';

import { mayOpenWorkpiece, maySeeWorkpiece } from '../auth/access.ts';
import { createWorkpiece, findWorkpiece } from '../db/collections/workpieces.ts';
import { summarizeUpdatesSince } from '../db/collections/updates.ts';
import type { WorkpieceHub } from '../realtime/hub.ts';
import { asCount, asObject, asObjectId, asText } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** The workpiece as a thing; working on it runs over the WebSocket, so nothing here writes. */
export function workpieceRoutes(db: Db, hub: WorkpieceHub): Router {
  const routes = Router();

  routes.param('id', requireId('workpiece'));

  const opening = guard((actor, id) => mayOpenWorkpiece(db, actor, id), 404, 'unknown workpiece');

  routes.post('/workpieces', async (request, response) => {
    const body = bodyOf(request);
    const name = asText(body['name']);

    if (name === undefined) {
      return fail(response, 400, 'name is missing');
    }

    const contract = asObject(body['contract']);
    const unusable = unusableField(body, { contract });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const workpiece = await createWorkpiece(db, {
      name,
      createdBy: actorOf(request).actorId,
      ...defined({ contract }),
    });

    // Born outside every room, so nobody may open it yet; putting it in one is its own step.
    response.status(201).json(workpiece);
  });

  routes.get('/workpieces/:id', async (request, response) => {
    const workpiece = await findWorkpiece(db, idOf(request));

    if (workpiece === null || !(await maySeeWorkpiece(db, actorOf(request), workpiece))) {
      return fail(response, 404, 'unknown workpiece');
    }

    response.json(workpiece);
  });

  /** The chain of changes, oldest first after since: who and when, the bytes only as a size. */
  routes.get('/workpieces/:id/updates', opening, async (request, response) => {
    const since = asObjectId(request.query['since']);
    const limit = asCount(request.query['limit']);

    const unusable = unusableField(request.query, { since, limit });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    response.json(await summarizeUpdatesSince(db, idOf(request), since, limit));
  });

  /** Names this moment; reason is the only place in the model for the why of a change. */
  routes.post('/workpieces/:id/checkpoints', opening, async (request, response) => {
    const body = bodyOf(request);
    const label = asText(body['label']);
    const reason = asText(body['reason']);

    const unusable = unusableField(body, { label, reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    response.status(201).json(
      await hub.checkpoint(idOf(request), {
        createdBy: actorOf(request).actorId,
        ...defined({ label, reason }),
      }),
    );
  });

  return routes;
}
