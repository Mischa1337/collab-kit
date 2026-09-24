import { Router } from 'express';
import type { Db } from 'mongodb';

import { mayChange, mayEnterRoom } from '../auth/access.ts';
import { readEventsSince } from '../db/collections/events.ts';
import {
  addToRoom,
  createRoom,
  findRoom,
  removeFromRoom,
  setRoomSettings,
} from '../db/collections/rooms.ts';
import { asCount, asObject, asObjectId, asReferenceId, asText } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId } from './http.ts';

/**
 * The room bundles, so these routes only ever move references around. Nothing here
 * creates or deletes the things pointed at.
 */
export function roomRoutes(db: Db): Router {
  const routes = Router();

  routes.param('id', requireId('room'));

  // Deliberately the same answer as a room that does not exist: whether one is there
  // is already more than somebody outside it should learn.
  const entering = guard((actor, id) => mayEnterRoom(db, actor, id), 404, 'unknown room');
  const changing = guard(
    (actor, id) => mayChange(db, actor, 'room', id),
    403,
    'not allowed to change this room',
  );

  routes.post('/rooms', async (request, response) => {
    const body = bodyOf(request);
    const name = asText(body['name']);

    if (name === undefined) {
      return fail(response, 400, 'name is missing');
    }

    const settings = asObject(body['settings']);
    const room = await createRoom(db, {
      name,
      createdBy: actorOf(request).actorId,
      ...defined({ settings }),
    });

    response.status(201).json(room);
  });

  routes.get('/rooms/:id', entering, async (request, response) => {
    response.json(await findRoom(db, idOf(request)));
  });

  routes.patch('/rooms/:id', changing, async (request, response) => {
    const settings = asObject(bodyOf(request)['settings']);

    if (settings === undefined) {
      return fail(response, 400, 'settings must be an object');
    }

    const id = idOf(request);
    await setRoomSettings(db, id, settings);
    response.json(await findRoom(db, id));
  });

  routes.post('/rooms/:id/contains', changing, async (request, response) => {
    const body = bodyOf(request);
    const kind = asText(body['kind']);

    if (kind === undefined || body['id'] === undefined) {
      return fail(response, 400, 'kind and id are needed');
    }

    const id = idOf(request);
    const added = await addToRoom(db, id, {
      kind,
      id: asReferenceId(body['id']),
      addedBy: actorOf(request).actorId,
    });

    // 200 and not 201 when it was already in: putting the same thing in twice is not
    // an error, it just did not change anything.
    response.status(added ? 201 : 200).json(await findRoom(db, id));
  });

  routes.delete('/rooms/:id/contains', changing, async (request, response) => {
    const body = bodyOf(request);
    const kind = asText(body['kind']);

    if (kind === undefined || body['id'] === undefined) {
      return fail(response, 400, 'kind and id are needed');
    }

    const id = idOf(request);
    await removeFromRoom(db, id, { kind, id: asReferenceId(body['id']) });
    response.json(await findRoom(db, id));
  });

  /**
   * Everything that happened in this room, oldest first, with `since` as the cut.
   *
   * The room has to resolve what it bundles, because the traces of the hub anchor at
   * the workpiece they belong to and not at the room. Asking for anchorKind=room alone
   * would find the chat and nothing of the work.
   */
  routes.get('/rooms/:id/events', entering, async (request, response) => {
    const id = idOf(request);
    const room = await findRoom(db, id);
    const anchorIds = [id, ...(room?.contains ?? []).map((entry) => entry.id)];
    const since = asObjectId(request.query['since']);
    const kind = asText(request.query['kind']);
    const limit = asCount(request.query['limit']);

    response.json(await readEventsSince(db, { anchorIds, ...defined({ since, kind, limit }) }));
  });

  return routes;
}
