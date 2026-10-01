/** Every rule on who may see or change what; routes and the gateway only ask. */

import { ObjectId, type Db } from 'mongodb';

import type { Actor } from '../model/actor.ts';
import type { Reference } from '../model/anchor.ts';
import { findWorkpiece, type WorkpieceRecord } from '../db/collections/workpieces.ts';
import { findComment } from '../db/collections/comments.ts';
import { findGroup, groupsOf, isMemberOfAny, type GroupRecord } from '../db/collections/groups.ts';
import {
  findRoom,
  roomsContaining,
  roomsCreatedByOrHolding,
  type RoomRecord,
} from '../db/collections/rooms.ts';
import { findTask, type Assignee, type TaskRecord } from '../db/collections/tasks.ts';

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

/** Every room maySeeRoom would let the actor see, as one list; keep both rules in step. */
export async function roomsVisibleTo(db: Db, actor: Actor): Promise<RoomRecord[]> {
  const groups = await groupsOf(db, actor.actorId);

  return roomsCreatedByOrHolding(
    db,
    actor.actorId,
    groups.map((group) => group._id),
  );
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

/** A task is seen by its creator, its assignees, and whoever may see its anchor or its parent. */
async function maySeeTask(db: Db, actor: Actor, task: TaskRecord): Promise<boolean> {
  const { assignees } = task;

  if (task.createdBy === actor.actorId) {
    return true;
  }
  if (assignees.some((entry) => entry.kind === 'actor' && entry.id === actor.actorId)) {
    return true;
  }
  // One query for all groups on the task; none at all asks nothing.
  const groupIds = assignees.filter((entry) => entry.kind === 'group').map((entry) => entry.id);
  if (await isMemberOfAny(db, groupIds, actor.actorId)) {
    return true;
  }
  if (task.anchor !== undefined && (await maySee(db, actor, task.anchor))) {
    return true;
  }
  return task.parentId !== undefined && maySee(db, actor, { kind: 'task', id: task.parentId });
}

/** Every assignee maySeeTask lets the actor see through: themselves and each of their groups. */
export async function assigneesFor(db: Db, actor: Actor): Promise<[Assignee, ...Assignee[]]> {
  const groups = await groupsOf(db, actor.actorId);

  return [
    { kind: 'actor', id: actor.actorId },
    ...groups.map((group) => ({ kind: 'group' as const, id: group._id })),
  ];
}

/** Provisional: whoever may see a task moves its state; each move keeps who and why. */
export async function maySetTaskState(db: Db, actor: Actor, taskId: ObjectId): Promise<boolean> {
  return maySee(db, actor, { kind: 'task', id: taskId });
}

/** Provisional: whoever may see a task gives and takes it, so a group can take one left lying. */
export async function mayAssignTask(db: Db, actor: Actor, taskId: ObjectId): Promise<boolean> {
  return maySee(db, actor, { kind: 'task', id: taskId });
}

/** Asked for each entry: any actor key, as the service cannot know them; a group only if seen. */
export async function mayAssignTo(db: Db, actor: Actor, assignee: Assignee): Promise<boolean> {
  return assignee.kind === 'actor' || maySee(db, actor, assignee);
}

/** Provisional: whoever may see a comment moves its state; each move keeps who and why, D8.16. */
export async function maySetCommentState(
  db: Db,
  actor: Actor,
  commentId: ObjectId,
): Promise<boolean> {
  return maySee(db, actor, { kind: 'comment', id: commentId });
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
