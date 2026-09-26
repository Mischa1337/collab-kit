/** Every rule on who may see or change what; routes and the gateway only ask. */

import { ObjectId, type Db } from 'mongodb';

import type { Actor } from '../model/actor.ts';
import type { Reference } from '../model/anchor.ts';
import { findWorkpiece, type WorkpieceRecord } from '../db/collections/workpieces.ts';
import { findComment } from '../db/collections/comments.ts';
import { findGroup, isMemberOfAny, type GroupRecord } from '../db/collections/groups.ts';
import { findRoom, roomsContaining, type RoomRecord } from '../db/collections/rooms.ts';
import { findTask, type TaskRecord } from '../db/collections/tasks.ts';

/** Open: some room bundles the workpiece and a group the actor is in. No room, nobody. */
export async function mayOpenWorkpiece(
  db: Db,
  actor: Actor,
  workpieceId: ObjectId,
): Promise<boolean> {
  const rooms = await roomsContaining(db, { kind: 'workpiece', id: workpieceId });
  const groupIds = rooms.flatMap((room) => groupsIn(room.references));

  return isMemberOfAny(db, groupIds, actor.actorId);
}

/** See it without working on it: whoever may open it, and its creator. */
export async function maySeeWorkpiece(
  db: Db,
  actor: Actor,
  workpiece: Pick<WorkpieceRecord, '_id' | 'createdBy'>,
): Promise<boolean> {
  if (workpiece.createdBy === actor.actorId) {
    return true;
  }

  return mayOpenWorkpiece(db, actor, workpiece._id);
}

/** See what a room bundles: a member of a group it holds, or whoever may change it. */
export async function maySeeRoom(db: Db, actor: Actor, roomId: ObjectId): Promise<boolean> {
  const room = await findRoom(db, roomId);

  if (room === null) {
    return false;
  }
  if (mayChangeRecord(actor, room)) {
    return true;
  }

  return isMemberOfAny(db, groupsIn(room.references), actor.actorId);
}

/** Seen by its members and whoever may change it, since who is in it tells what it opens. */
export function maySeeGroup(
  actor: Actor,
  group: Pick<GroupRecord, 'createdBy' | 'members'>,
): boolean {
  return mayChangeRecord(actor, group) || group.members.includes(actor.actorId);
}

/** May the actor see what a reference names? Only the service's own kinds are decided. */
export async function maySee(db: Db, actor: Actor, target: Reference): Promise<boolean> {
  if (!(target.id instanceof ObjectId)) {
    return true;
  }
  if (target.kind === 'workpiece') {
    const workpiece = await findWorkpiece(db, target.id);
    return workpiece !== null && maySeeWorkpiece(db, actor, workpiece);
  }
  if (target.kind === 'room') {
    return maySeeRoom(db, actor, target.id);
  }
  if (target.kind === 'group') {
    const group = await findGroup(db, target.id);
    return group !== null && maySeeGroup(actor, group);
  }
  if (target.kind === 'comment') {
    // A comment is as visible as what it is about, down the chain to a workpiece or room.
    const comment = await findComment(db, target.id);
    return comment !== null && maySee(db, actor, comment.anchor);
  }
  if (target.kind === 'task') {
    const task = await findTask(db, target.id);
    return task !== null && maySeeTask(db, actor, task);
  }
  return true;
}

/** A task is seen by its creator, its assignee, and whoever may see its anchor or its parent. */
async function maySeeTask(db: Db, actor: Actor, task: TaskRecord): Promise<boolean> {
  const { assignee } = task;

  if (task.createdBy === actor.actorId) {
    return true;
  }
  if (assignee?.kind === 'actor' && assignee.id === actor.actorId) {
    return true;
  }
  if (assignee?.kind === 'group' && assignee.id instanceof ObjectId) {
    if (await isMemberOfAny(db, [assignee.id], actor.actorId)) {
      return true;
    }
  }
  if (task.anchor !== undefined && (await maySee(db, actor, task.anchor))) {
    return true;
  }
  return task.parentId !== undefined && maySee(db, actor, { kind: 'task', id: task.parentId });
}

/** Whether the actor may change a room or group, looked up by its id. */
export async function mayChange(
  db: Db,
  actor: Actor,
  kind: 'room' | 'group',
  id: ObjectId,
): Promise<boolean> {
  const found = kind === 'room' ? await findRoom(db, id) : await findGroup(db, id);

  return found !== null && mayChangeRecord(actor, found);
}

/** Provisional: only the creator changes a room or group, as changing hands out access. */
function mayChangeRecord(
  actor: Actor,
  found: Pick<RoomRecord | GroupRecord, 'createdBy'>,
): boolean {
  return found.createdBy === actor.actorId;
}

/** The groups a room holds; references the service does not keep grant nothing. */
function groupsIn(references: readonly Reference[]): ObjectId[] {
  return references
    .filter((entry) => entry.kind === 'group')
    .map((entry) => entry.id)
    .filter((id) => id instanceof ObjectId);
}
