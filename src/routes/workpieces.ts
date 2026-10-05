import { Router } from 'express';
import type { Db } from 'mongodb';

import { may, maySee } from '../auth/access.ts';
import { addToRoom } from '../db/collections/rooms.ts';
import { createWorkpiece, findWorkpiece } from '../db/collections/workpieces.ts';
import { isUpdateOf, summarizeUpdatesSince } from '../db/collections/updates.ts';
import type { WorkpieceHub } from '../realtime/hub.ts';
import { readStateAt } from '../realtime/persistence.ts';
import { asCount, asObject, asObjectId, asText } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** The workpiece as a thing; working on it runs over the WebSocket, so nothing here writes. */
export function workpieceRoutes(db: Db, hub: WorkpieceHub): Router {
  const routes = Router();

  routes.param('id', requireId('workpiece'));

  // Reading what is there, the history as the state: whoever sees it.
  const seeing = guard(
    (actor, id) => maySee(db, actor, { kind: 'workpiece', id }),
    404,
    'unknown workpiece',
  );
  // Naming a moment of the work belongs to whoever may write it; behind seeing, so 403 after 404.
  const editing = guard(
    (actor, id) => may(db, actor, 'edit', { kind: 'workpiece', id }),
    403,
    'not allowed to name a moment of this workpiece',
  );

  routes.post('/workpieces', async (request, response) => {
    const body = bodyOf(request);
    const name = asText(body['name']);

    if (name === undefined) {
      return fail(response, 400, 'name is missing');
    }

    const contract = asObject(body['contract']);
    const roomId = asObjectId(body['roomId']);
    const unusable = unusableField(body, { contract, roomId });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    // In a room it takes manage there; outside every room it lies in nothing, so manage everywhere.
    const actor = actorOf(request);
    const room = roomId === undefined ? undefined : { kind: 'room', id: roomId };
    if (room !== undefined && !(await maySee(db, actor, room))) {
      return fail(response, 404, 'unknown room');
    }
    if (!(await may(db, actor, 'manage', room))) {
      return fail(response, 403, 'not allowed to create a workpiece here');
    }

    const workpiece = await createWorkpiece(db, {
      name,
      createdBy: actor.actorId,
      ...defined({ contract }),
    });
    if (roomId !== undefined) {
      await addToRoom(db, roomId, { kind: 'workpiece', id: workpiece._id, addedBy: actor.actorId });
    }

    response.status(201).json(workpiece);
  });

  routes.get('/workpieces/:id', async (request, response) => {
    const id = idOf(request);
    const workpiece = await findWorkpiece(db, id);

    if (workpiece === null || !(await maySee(db, actorOf(request), { kind: 'workpiece', id }))) {
      return fail(response, 404, 'unknown workpiece');
    }

    response.json(workpiece);
  });

  /** The chain of changes, oldest first after since: who and when, the bytes only as a size. */
  routes.get('/workpieces/:id/updates', seeing, async (request, response) => {
    const since = asObjectId(request.query['since']);
    const limit = asCount(request.query['limit']);

    const unusable = unusableField(request.query, { since, limit });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    response.json(await summarizeUpdatesSince(db, idOf(request), since, limit));
  });

  /** The stored state as Yjs bytes after the change at, or the newest; restoring is the tool's. */
  routes.get('/workpieces/:id/state', seeing, async (request, response) => {
    const at = asObjectId(request.query['at']);

    const unusable = unusableField(request.query, { at });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const id = idOf(request);
    if (at !== undefined && !(await isUpdateOf(db, id, at))) {
      return fail(response, 404, 'unknown change');
    }

    const { state, upToUpdateId } = await readStateAt(db, id, at);
    // Which change the state reaches, so the tool knows what it holds.
    if (upToUpdateId !== undefined) {
      response.set('X-Up-To-Update-Id', upToUpdateId.toHexString());
    }
    response.type('application/octet-stream').send(Buffer.from(state));
  });

  /** Names this moment; reason is the only place in the model for the why of a change. */
  routes.post('/workpieces/:id/checkpoints', seeing, editing, async (request, response) => {
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
