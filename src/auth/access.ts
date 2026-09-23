import { ObjectId, type Db } from 'mongodb';

import { isMemberOfAny } from '../db/collections/groups.ts';
import { findRoom, roomsContaining, type Containment } from '../db/collections/rooms.ts';
import type { Actor } from './token.ts';

export interface AccessRequest {
  readonly db: Db;
  readonly actor: Actor;
  readonly documentId: ObjectId;
}

/**
 * The single place that decides who may open a document. It knows neither HTTP nor
 * WebSocket, so both ways in ask the same question.
 *
 * The rule: there is a room that bundles this document and a group this actor is in.
 * Nothing finer than that is decided here, because a group in a room is already the
 * role, and which roles exist is the business of the docking tool.
 *
 * Two consequences worth knowing. A document that sits in no room cannot be opened by
 * anybody, not even by whoever created it. And a room that holds a document but no
 * group locks everyone out, which is correct and looks like a fault the first time.
 */
export async function mayOpenDocument(request: AccessRequest): Promise<boolean> {
  const rooms = await roomsContaining(request.db, {
    kind: 'document',
    id: request.documentId,
  });

  const groupIds = rooms.flatMap((room) => groupsIn(room.contains));

  return isMemberOfAny(request.db, groupIds, request.actor.actorId);
}

/**
 * Whether the actor may see what a room bundles. The same rule as for a document, one
 * step shorter: membership in a group the room holds.
 *
 * The creator is let in as well. A fresh room holds no group yet, so without this
 * clause whoever just created one could not put the first group into it.
 */
export async function mayEnterRoom(db: Db, actor: Actor, roomId: ObjectId): Promise<boolean> {
  const room = await findRoom(db, roomId);

  if (room === null) {
    return false;
  }
  if (room.createdBy === actor.actorId) {
    return true;
  }

  return isMemberOfAny(db, groupsIn(room.contains), actor.actorId);
}

/**
 * Whether the actor may change a room or a group.
 *
 * Provisional, and the one rule in here that is not derived from the model: whoever
 * created a thing may change it. Something has to hold, because the right to open a
 * document is derived from membership, so whoever may change a group hands out access
 * to everything that group opens.
 *
 * When the real rule is decided, this is the only function to replace.
 */
export async function mayChange(
  db: Db,
  actor: Actor,
  collection: 'rooms' | 'groups',
  id: ObjectId,
): Promise<boolean> {
  const found = await db
    .collection(collection)
    .findOne({ _id: id }, { projection: { createdBy: 1 } });

  return found !== null && found['createdBy'] === actor.actorId;
}

/**
 * Only what the service keeps itself is resolved. A room may bundle kinds this
 * service has never heard of, and those cannot grant anything here.
 */
function groupsIn(contains: readonly Containment[]): ObjectId[] {
  return contains
    .filter((entry) => entry.kind === 'group')
    .map((entry) => entry.id)
    .filter((id) => id instanceof ObjectId);
}
