import { Router } from 'express';
import { ObjectId, type Db } from 'mongodb';

import { may, maySee, roomsVisibleTo } from '../auth/access.ts';
import { grantsAt, isScopeKind } from '../db/collections/grants.ts';
import { readEventsSince } from '../db/collections/events.ts';
import {
  addToRoom,
  createRoom,
  findRoom,
  removeFromRoom,
  setRoomSettings,
} from '../db/collections/rooms.ts';
import { asActorId, asCount, asObject, asObjectId, asReference, asText } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** A room bundles: these routes move references, never create or delete what they point at. */
export function roomRoutes(db: Db, recheckAccess: () => Promise<void>): Router {
  const routes = Router();

  routes.param('id', requireId('room'));

  // 404 as for a missing room: that one exists is already more than an outsider should learn.
  const seeing = guard((actor, id) => maySee(db, actor, { kind: 'room', id }), 404, 'unknown room');
  // Behind seeing, so 403 tells only whoever already sees the room.
  const changing = guard(
    (actor, id) => may(db, actor, 'manage', { kind: 'room', id }),
    403,
    'not allowed to change this room',
  );

  routes.post('/rooms', async (request, response) => {
    // A room lies in nothing, so creating one takes manage everywhere.
    if (!(await may(db, actorOf(request), 'manage'))) {
      return fail(response, 403, 'not allowed to create a room');
    }

    const body = bodyOf(request);
    const name = asText(body['name']);

    if (name === undefined) {
      return fail(response, 400, 'name is missing');
    }

    const settings = asObject(body['settings']);
    const unusable = unusableField(body, { settings });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const room = await createRoom(db, {
      name,
      createdBy: actorOf(request).actorId,
      ...defined({ settings }),
    });

    response.status(201).json(room);
  });

  routes.get('/rooms/:id', seeing, async (request, response) => {
    response.json(await findRoom(db, idOf(request)));
  });

  routes.patch('/rooms/:id', seeing, changing, async (request, response) => {
    const settings = asObject(bodyOf(request)['settings']);

    if (settings === undefined) {
      return fail(response, 400, 'settings must be an object');
    }

    const id = idOf(request);
    await setRoomSettings(db, id, settings);
    response.json(await findRoom(db, id));
  });

  routes.post('/rooms/:id/references', seeing, changing, async (request, response) => {
    const reference = asReference(bodyOf(request));

    if (reference === undefined) {
      return fail(response, 400, 'kind and id are needed, both as text');
    }
    // Who may into a room stands in its grants, a group in here would open nothing.
    if (reference.kind === 'group') {
      return fail(response, 400, 'a group gets into a room through PUT /grants');
    }

    const actor = actorOf(request);
    if (!(await maySee(db, actor, reference))) {
      return fail(response, 404, 'unknown reference');
    }
    // In here it gets the rights of the room, so a thing of the service takes manage at it too.
    const own = isScopeKind(reference.kind) && reference.id instanceof ObjectId;
    if (own && !(await may(db, actor, 'manage', reference))) {
      return fail(response, 403, 'not allowed to hand this on');
    }

    const id = idOf(request);
    const added = await addToRoom(db, id, { ...reference, addedBy: actor.actorId });

    // 200 if it was already in: adding it twice is no error, it just changes nothing.
    response.status(added ? 201 : 200).json(await findRoom(db, id));
  });

  // In the query and not the body: a body on DELETE may get lost on the way.
  routes.delete('/rooms/:id/references', seeing, changing, async (request, response) => {
    const reference = asReference(request.query);

    if (reference === undefined) {
      return fail(response, 400, 'kind and id are needed, both as text');
    }

    const id = idOf(request);
    await removeFromRoom(db, id, { ...reference, removedBy: actorOf(request).actorId });
    // Without the reference, open connections to what it opened would carry on as before.
    await recheckAccess();
    response.json(await findRoom(db, id));
  });

  /** The room and all it bundles, oldest first after since; hub traces anchor at workpieces. */
  routes.get('/rooms/:id/events', seeing, async (request, response) => {
    const since = asObjectId(request.query['since']);
    const kind = asText(request.query['kind']);
    const createdBy = asActorId(request.query['createdBy']);
    const limit = asCount(request.query['limit']);

    const unusable = unusableField(request.query, { since, kind, createdBy, limit });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const id = idOf(request);
    const room = await findRoom(db, id);
    // The groups that may into the room belong to its stream, as when they lay in it.
    const holders = await grantsAt(db, { kind: 'room', id });
    const bundled = [
      ...(room?.references ?? []),
      ...holders.map((grant) => ({ kind: 'group', id: grant.groupId })),
    ];
    // Only what the actor may see, so the room shows no more than /events would.
    const actor = actorOf(request);
    const visible = await Promise.all(bundled.map((reference) => maySee(db, actor, reference)));
    const seen = bundled.filter((_, index) => visible[index]);

    response.json(
      await readEventsSince(db, {
        references: [{ kind: 'room', id }, ...seen],
        ...defined({ since, kind, createdBy, limit }),
      }),
    );
  });

  /** Where a client starts: every room this token may see. */
  routes.get('/me/rooms', async (request, response) => {
    response.json(await roomsVisibleTo(db, actorOf(request)));
  });

  return routes;
}
