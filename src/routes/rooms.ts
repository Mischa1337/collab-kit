import { Router } from 'express';
import type { Db, ObjectId } from 'mongodb';

import { may, maySee, roomsVisibleTo } from '../auth/access.ts';
import { grantsAt } from '../db/collections/grants.ts';
import { latestPerActor, readEventsSince } from '../db/collections/events.ts';
import {
  addToRoom,
  createRoom,
  deleteRoom,
  findRoom,
  removeFromRoom,
  renameRoom,
  setRoomSettings,
} from '../db/collections/rooms.ts';
import { eventKeysOf, withNames } from '../db/names.ts';
import type { Actor } from '../model/actor.ts';
import type { Reference } from '../model/anchor.ts';
import { asActorId, asCount, asObject, asObjectId, asReference, asText } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** What a reference in a room needs, for the 400 of the routes that move one. */
const ROOM_REFERENCE_RULE =
  'a room references only kind workpiece, with an id of 24 hex characters';

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

    response.status(201).json(await withNames(db, room));
  });

  routes.get('/rooms/:id', seeing, async (request, response) => {
    response.json(await withNames(db, await findRoom(db, idOf(request))));
  });

  routes.patch('/rooms/:id', seeing, changing, async (request, response) => {
    const body = bodyOf(request);
    const name = asText(body['name']);
    const settings = asObject(body['settings']);
    const reason = asText(body['reason']);

    const unusable = unusableField(body, { name, settings, reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }
    if (name === undefined && settings === undefined) {
      return fail(response, 400, 'name or settings is needed');
    }

    // Only the name leaves a trace; the settings are the tool's and never read here.
    const id = idOf(request);
    if (name !== undefined) {
      await renameRoom(db, id, {
        name,
        renamedBy: actorOf(request).actorId,
        ...defined({ reason }),
      });
    }
    if (settings !== undefined) {
      await setRoomSettings(db, id, settings);
    }
    response.json(await withNames(db, await findRoom(db, id)));
  });

  // The reason in the query, as a body on DELETE may get lost on the way.
  routes.delete('/rooms/:id', seeing, changing, async (request, response) => {
    const reason = asText(request.query['reason']);

    const unusable = unusableField(request.query, { reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const deleted = await deleteRoom(db, idOf(request), {
      deletedBy: actorOf(request).actorId,
      ...defined({ reason }),
    });
    // Without the room and its grants, open connections to what it opened would carry on.
    if (deleted) {
      await recheckAccess();
    }
    response.json({ deleted });
  });

  routes.post('/rooms/:id/references', seeing, changing, async (request, response) => {
    const reference = asReference(bodyOf(request));

    // Who may into a room stands in its grants, a group in here would open nothing.
    if (reference?.kind === 'group') {
      return fail(response, 400, 'a group gets into a room through PUT /grants');
    }
    if (reference?.kind !== 'workpiece') {
      return fail(response, 400, ROOM_REFERENCE_RULE);
    }

    const actor = actorOf(request);
    if (!(await maySee(db, actor, reference))) {
      return fail(response, 404, 'unknown reference');
    }
    // In here it gets the rights of the room, so it takes manage at it too.
    if (!(await may(db, actor, 'manage', reference))) {
      return fail(response, 403, 'not allowed to hand this on');
    }

    const id = idOf(request);
    const added = await addToRoom(db, id, {
      kind: 'workpiece',
      id: reference.id,
      addedBy: actor.actorId,
    });

    // 200 if it was already in: adding it twice is no error, it just changes nothing.
    response.status(added ? 201 : 200).json(await withNames(db, await findRoom(db, id)));
  });

  // In the query and not the body: a body on DELETE may get lost on the way.
  routes.delete('/rooms/:id/references', seeing, changing, async (request, response) => {
    const reference = asReference(request.query);

    if (reference?.kind !== 'workpiece') {
      return fail(response, 400, ROOM_REFERENCE_RULE);
    }

    const id = idOf(request);
    await removeFromRoom(db, id, {
      kind: 'workpiece',
      id: reference.id,
      removedBy: actorOf(request).actorId,
    });
    // Without the reference, open connections to what it opened would carry on as before.
    await recheckAccess();
    response.json(await withNames(db, await findRoom(db, id)));
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

    const references = await bundledIn(db, actorOf(request), idOf(request));
    const events = await readEventsSince(db, {
      references,
      ...defined({ since, kind, createdBy, limit }),
    });
    response.json(await withNames(db, events, eventKeysOf));
  });

  /** Per person the last trace in the room and all it bundles, newest first (D1.10). */
  routes.get('/rooms/:id/activity', seeing, async (request, response) => {
    const references = await bundledIn(db, actorOf(request), idOf(request));
    response.json(await withNames(db, await latestPerActor(db, references)));
  });

  /** Where a client starts: every room this token may see. */
  routes.get('/me/rooms', async (request, response) => {
    response.json(await withNames(db, await roomsVisibleTo(db, actorOf(request))));
  });

  return routes;
}

/** The room and what it bundles, as far as the actor sees it: where its stream reads. */
async function bundledIn(db: Db, actor: Actor, id: ObjectId): Promise<[Reference, ...Reference[]]> {
  const room = await findRoom(db, id);
  // The groups that may into the room belong to its stream, as when they lay in it.
  const holders = await grantsAt(db, { kind: 'room', id });
  const bundled: Reference[] = [
    ...(room?.references ?? []),
    ...holders.map((grant) => ({ kind: 'group' as const, id: grant.groupId })),
  ];
  // Only what the actor may see, so the room shows no more than /events would.
  const visible = await Promise.all(bundled.map((reference) => maySee(db, actor, reference)));
  return [{ kind: 'room', id }, ...bundled.filter((_, index) => visible[index])];
}
