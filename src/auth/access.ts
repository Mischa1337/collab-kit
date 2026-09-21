import { ObjectId, type Db } from 'mongodb';

import { isMemberOfAny } from '../db/collections/groups.ts';
import { roomsContaining } from '../db/collections/rooms.ts';
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

  // Only what the service keeps itself is resolved. A room may bundle kinds this
  // service has never heard of, and those cannot grant anything here.
  const groupIds = rooms
    .flatMap((room) => room.contains)
    .filter((entry) => entry.kind === 'group')
    .map((entry) => entry.id)
    .filter((id) => id instanceof ObjectId);

  return isMemberOfAny(request.db, groupIds, request.actor.actorId);
}
