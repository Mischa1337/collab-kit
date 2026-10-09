import { Router } from 'express';
import type { Db, ObjectId } from 'mongodb';

import { may, maySee, workpiecesVisibleTo } from '../auth/access.ts';
import { addToRoom } from '../db/collections/rooms.ts';
import { createWorkpiece, findWorkpiece } from '../db/collections/workpieces.ts';
import { latestPerActor } from '../db/collections/events.ts';
import { isUpdateOf, summarizeUpdatesSince } from '../db/collections/updates.ts';
import { eventKeysOf, withNames } from '../db/names.ts';
import type { Actor } from '../model/actor.ts';
import { forkWorkpiece, mergeWorkpiece } from '../realtime/forks.ts';
import type { WorkpieceHub } from '../realtime/hub.ts';
import { readStateAt } from '../realtime/persistence.ts';
import { asCount, asObject, asObjectId, asText, asUnits } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** The workpiece as a thing; typing runs over the WebSocket, here only a merge writes into one. */
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
  // A merge writes into the workpiece as typing does; behind seeing, so 403 after 404.
  const merging = guard(
    (actor, id) => may(db, actor, 'edit', { kind: 'workpiece', id }),
    403,
    'not allowed to change this workpiece',
  );

  /** Why creating a workpiece there is refused: it takes manage in the room, else everywhere. */
  async function refusalToCreate(
    actor: Actor,
    roomId: ObjectId | undefined,
  ): Promise<[number, string] | undefined> {
    // Outside every room it lies in nothing, so manage everywhere.
    const room = roomId === undefined ? undefined : { kind: 'room' as const, id: roomId };
    if (room !== undefined && !(await maySee(db, actor, room))) {
      return [404, 'unknown room'];
    }
    if (!(await may(db, actor, 'manage', room))) {
      return [403, 'not allowed to create a workpiece here'];
    }
    return undefined;
  }

  routes.post('/workpieces', async (request, response) => {
    const body = bodyOf(request);
    const name = asText(body['name']);

    if (name === undefined) {
      return fail(response, 400, 'name is missing');
    }

    const contract = asObject(body['contract']);
    const roomId = asObjectId(body['roomId']);
    const units = asUnits(body['units']);
    const unusable = unusableField(body, { contract, roomId, units });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const actor = actorOf(request);
    const refused = await refusalToCreate(actor, roomId);
    if (refused !== undefined) {
      return fail(response, ...refused);
    }

    const workpiece = await createWorkpiece(db, {
      name,
      createdBy: actor.actorId,
      ...defined({ contract, units }),
    });
    if (roomId !== undefined) {
      await addToRoom(db, roomId, { kind: 'workpiece', id: workpiece._id, addedBy: actor.actorId });
    }

    response.status(201).json(await withNames(db, workpiece));
  });

  /** Every workpiece this token may see, so a tool can offer them, say for a room. */
  routes.get('/workpieces', async (request, response) => {
    response.json(await withNames(db, await workpiecesVisibleTo(db, actorOf(request))));
  });

  routes.get('/workpieces/:id', async (request, response) => {
    const id = idOf(request);
    const workpiece = await findWorkpiece(db, id);

    if (workpiece === null || !(await maySee(db, actorOf(request), { kind: 'workpiece', id }))) {
      return fail(response, 404, 'unknown workpiece');
    }

    response.json(await withNames(db, workpiece));
  });

  /** The chain of changes, oldest first after since: who and when, the bytes only as a size. */
  routes.get('/workpieces/:id/updates', seeing, async (request, response) => {
    const since = asObjectId(request.query['since']);
    const limit = asCount(request.query['limit']);

    const unusable = unusableField(request.query, { since, limit });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    response.json(
      await withNames(db, await summarizeUpdatesSince(db, idOf(request), since, limit)),
    );
  });

  /** Per person the last trace at the workpiece and its comments and tasks, newest first. */
  routes.get('/workpieces/:id/activity', seeing, async (request, response) => {
    const activity = await latestPerActor(db, [{ kind: 'workpiece', id: idOf(request) }]);
    response.json(await withNames(db, activity));
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

    const checkpoint = await hub.checkpoint(idOf(request), {
      createdBy: actorOf(request).actorId,
      ...defined({ label, reason }),
    });
    response.status(201).json(await withNames(db, checkpoint, eventKeysOf));
  });

  /** A copy of the history up to a point, each change under its author, to work on apart. */
  routes.post('/workpieces/:id/forks', seeing, async (request, response) => {
    const body = bodyOf(request);
    const name = asText(body['name']);

    if (name === undefined) {
      return fail(response, 400, 'name is missing');
    }

    const at = asObjectId(body['at']);
    const roomId = asObjectId(body['roomId']);
    const reason = asText(body['reason']);
    const unusable = unusableField(body, { at, roomId, reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    // Only a change of this very workpiece, as for its state.
    const id = idOf(request);
    if (at !== undefined && !(await isUpdateOf(db, id, at))) {
      return fail(response, 404, 'unknown change');
    }
    // The same rule as creating one; reading the source took only seeing it.
    const actor = actorOf(request);
    const refused = await refusalToCreate(actor, roomId);
    if (refused !== undefined) {
      return fail(response, ...refused);
    }

    const fork = await forkWorkpiece(db, hub, id, {
      name,
      createdBy: actor.actorId,
      ...defined({ at, roomId, reason }),
    });
    response.status(201).json(await withNames(db, fork));
  });

  /** Replays what another workpiece has beyond the last merge, each change under its author. */
  routes.post('/workpieces/:id/merges', seeing, merging, async (request, response) => {
    const body = bodyOf(request);
    const from = asObjectId(body['from']);

    if (from === undefined) {
      return fail(
        response,
        400,
        body['from'] === undefined ? 'from is missing' : 'from is unusable',
      );
    }

    const reason = asText(body['reason']);
    const unusable = unusableField(body, { reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const id = idOf(request);
    if (from.equals(id)) {
      return fail(response, 400, 'a workpiece cannot be merged into itself');
    }
    // Reading the source takes seeing it, as reading its state does.
    const actor = actorOf(request);
    if (!(await maySee(db, actor, { kind: 'workpiece', id: from }))) {
      return fail(response, 404, 'unknown workpiece to merge from');
    }

    const merged = await mergeWorkpiece(db, hub, id, {
      from,
      createdBy: actor.actorId,
      ...defined({ reason }),
    });
    response.status(201).json(await withNames(db, merged, eventKeysOf));
  });

  return routes;
}
