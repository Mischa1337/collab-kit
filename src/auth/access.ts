/**
 * Every rule about who may see or change what, and nowhere else. Routes and the
 * gateway ask and never decide, so changing a rule means changing this file only.
 */

import { ObjectId, type Db } from 'mongodb';

import type { Actor } from '../model/actor.ts';
import type { Reference } from '../model/anchor.ts';
import type { DocumentRecord } from '../db/collections/documents.ts';
import { findGroup, isMemberOfAny, type Group } from '../db/collections/groups.ts';
import { findRoom, roomsContaining, type Containment } from '../db/collections/rooms.ts';

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
 * Whether the actor may read what is known about a document, without working on it.
 * The same rule as for opening, plus the creator, so a document that sits in no room
 * yet is not lost to whoever made it.
 */
export async function mayReadDocument(
  db: Db,
  actor: Actor,
  document: Pick<DocumentRecord, '_id' | 'createdBy'>,
): Promise<boolean> {
  if (document.createdBy === actor.actorId) {
    return true;
  }

  return mayOpenDocument({ db, actor, documentId: document._id });
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
 * Whether the actor may see a group: its members and whoever created it, nobody else.
 * Who is in a group is exactly what that group opens.
 */
export function maySeeGroup(actor: Actor, group: Pick<Group, 'createdBy' | 'members'>): boolean {
  return (
    group.createdBy === actor.actorId ||
    group.members.some((member) => member.actorId === actor.actorId)
  );
}

/**
 * Whether the actor may look at the thing a reference names, which is what reading or
 * leaving a trace at an anchor asks. Only the kinds the service keeps itself are
 * decided here; for everything a tool anchors at, there is nothing this service could
 * ask.
 */
export async function mayReach(db: Db, actor: Actor, target: Reference): Promise<boolean> {
  if (!(target.id instanceof ObjectId)) {
    return true;
  }
  if (target.kind === 'document') {
    return mayOpenDocument({ db, actor, documentId: target.id });
  }
  if (target.kind === 'room') {
    return mayEnterRoom(db, actor, target.id);
  }
  return true;
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
  kind: 'room' | 'group',
  id: ObjectId,
): Promise<boolean> {
  const found = kind === 'room' ? await findRoom(db, id) : await findGroup(db, id);

  return found !== null && found.createdBy === actor.actorId;
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
