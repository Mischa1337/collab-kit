import { Router } from 'express';
import type { Db } from 'mongodb';

import { mayOpenWorkpiece, mayReadWorkpiece } from '../auth/access.ts';
import { createWorkpiece, findWorkpiece } from '../db/collections/workpieces.ts';
import { readUpdatesSince } from '../db/collections/updates.ts';
import { asObject, asObjectId, asText } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import type { WorkpieceHub } from '../realtime/hub.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId } from './http.ts';

/**
 * The working on a workpiece runs over the WebSocket, which is why nothing here writes
 * into one. These routes are about the workpiece as a thing: creating it, reading what
 * the tool declared about it, and reading the chain of what happened to it.
 */
export function workpieceRoutes(db: Db, hub: WorkpieceHub): Router {
  const routes = Router();

  routes.param('id', requireId('workpiece'));

  const opening = guard(
    (actor, id) => mayOpenWorkpiece({ db, actor, workpieceId: id }),
    404,
    'unknown workpiece',
  );

  routes.post('/workpieces', async (request, response) => {
    const body = bodyOf(request);
    const name = asText(body['name']);

    if (name === undefined) {
      return fail(response, 400, 'name is missing');
    }

    const contract = asObject(body['contract']);
    const workpiece = await createWorkpiece(db, {
      name,
      createdBy: actorOf(request).actorId,
      ...defined({ contract }),
    });

    // Born outside every room and therefore openable by nobody yet. Putting it into
    // one is a separate step, because the room bundles and does not own.
    response.status(201).json(workpiece);
  });

  routes.get('/workpieces/:id', async (request, response) => {
    const workpiece = await findWorkpiece(db, idOf(request));

    if (workpiece === null || !(await mayReadWorkpiece(db, actorOf(request), workpiece))) {
      return fail(response, 404, 'unknown workpiece');
    }

    // Named field by field rather than handed out as it is stored. The folded state
    // stays out: it is the shortcut for loading and belongs to the socket, not to a
    // client reading about the workpiece.
    response.json({
      _id: workpiece._id,
      name: workpiece.name,
      contract: workpiece.contract,
      createdAt: workpiece.createdAt,
      createdBy: workpiece.createdBy,
      ...defined({ foldedUpToUpdateId: workpiece.fold?.upToUpdateId }),
    });
  });

  /**
   * The chain of changes, oldest first, `since` as the cut. What the bytes mean is
   * the business of the tool; what the service adds is who and when.
   */
  routes.get('/workpieces/:id/updates', opening, async (request, response) => {
    const since = asObjectId(request.query['since']);
    const updates = await readUpdatesSince(db, idOf(request), since);

    response.json(
      updates.map((update) => ({
        _id: update._id,
        createdBy: update.createdBy,
        createdAt: update.createdAt,
        bytes: update.bytes.length(),
      })),
    );
  });

  /**
   * Holds this moment under a name. `reason` is the only place in the whole model
   * where the why of a change can live, which is why it is worth its own route.
   */
  routes.post('/workpieces/:id/checkpoints', opening, async (request, response) => {
    const body = bodyOf(request);
    const label = asText(body['label']);
    const reason = asText(body['reason']);

    response.status(201).json(
      await hub.checkpoint(idOf(request), {
        createdBy: actorOf(request).actorId,
        ...defined({ label, reason }),
      }),
    );
  });

  return routes;
}
