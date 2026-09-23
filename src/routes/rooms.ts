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
import {
  actorOf,
  asCount,
  asObject,
  asObjectId,
  asReferenceId,
  asText,
  bodyOf,
  fail,
} from './http.ts';

/**
 * The room bundles, so these routes only ever move references around. Nothing here
 * creates or deletes the things pointed at.
 */
export function roomRoutes(db: Db): Router {
  const routes = Router();

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
      ...(settings === undefined ? {} : { settings }),
    });

    response.status(201).json(room);
  });

  routes.get('/rooms/:id', async (request, response) => {
    const id = asObjectId(request.params['id']);

    if (id === undefined) {
      return fail(response, 400, 'malformed room key');
    }
    if (!(await mayEnterRoom(db, actorOf(request), id))) {
      // Deliberately the same answer as a room that does not exist: whether one is
      // there is already more than somebody outside it should learn.
      return fail(response, 404, 'unknown room');
    }

    response.json(await findRoom(db, id));
  });

  routes.patch('/rooms/:id', async (request, response) => {
    const id = asObjectId(request.params['id']);
    const settings = asObject(bodyOf(request)['settings']);

    if (id === undefined) {
      return fail(response, 400, 'malformed room key');
    }
    if (settings === undefined) {
      return fail(response, 400, 'settings must be an object');
    }
    if (!(await mayChange(db, actorOf(request), 'rooms', id))) {
      return fail(response, 403, 'not allowed to change this room');
    }

    await setRoomSettings(db, id, settings);
    response.json(await findRoom(db, id));
  });

  routes.post('/rooms/:id/contains', async (request, response) => {
    const id = asObjectId(request.params['id']);
    const body = bodyOf(request);
    const kind = asText(body['kind']);

    if (id === undefined) {
      return fail(response, 400, 'malformed room key');
    }
    if (kind === undefined || body['id'] === undefined) {
      return fail(response, 400, 'kind and id are needed');
    }
    if (!(await mayChange(db, actorOf(request), 'rooms', id))) {
      return fail(response, 403, 'not allowed to change this room');
    }

    const added = await addToRoom(db, id, {
      kind,
      id: asReferenceId(body['id']),
      addedBy: actorOf(request).actorId,
    });

    // 200 and not 201 when it was already in: putting the same thing in twice is not
    // an error, it just did not change anything.
    response.status(added ? 201 : 200).json(await findRoom(db, id));
  });

  routes.delete('/rooms/:id/contains', async (request, response) => {
    const id = asObjectId(request.params['id']);
    const body = bodyOf(request);
    const kind = asText(body['kind']);

    if (id === undefined) {
      return fail(response, 400, 'malformed room key');
    }
    if (kind === undefined || body['id'] === undefined) {
      return fail(response, 400, 'kind and id are needed');
    }
    if (!(await mayChange(db, actorOf(request), 'rooms', id))) {
      return fail(response, 403, 'not allowed to change this room');
    }

    await removeFromRoom(db, id, { kind, id: asReferenceId(body['id']) });
    response.json(await findRoom(db, id));
  });

  /**
   * Everything that happened in this room, oldest first, with `since` as the cut.
   *
   * The room has to resolve what it bundles, because the traces of the hub anchor at
   * the document they belong to and not at the room. Asking for anchorKind=room alone
   * would find the chat and nothing of the work.
   */
  routes.get('/rooms/:id/events', async (request, response) => {
    const id = asObjectId(request.params['id']);

    if (id === undefined) {
      return fail(response, 400, 'malformed room key');
    }
    if (!(await mayEnterRoom(db, actorOf(request), id))) {
      return fail(response, 404, 'unknown room');
    }

    const room = await findRoom(db, id);
    const anchorIds = [id, ...(room?.contains ?? []).map((entry) => entry.id)];
    const since = asObjectId(request.query['since']);
    const kind = asText(request.query['kind']);
    const limit = asCount(request.query['limit']);

    response.json(
      await readEventsSince(db, {
        anchorIds,
        ...(since === undefined ? {} : { since }),
        ...(kind === undefined ? {} : { kind }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
  });

  return routes;
}
