/** Every rule on who may see or change what; routes and the gateway only ask. */

import { ObjectId, type Db } from 'mongodb';

import type { Actor } from '../model/actor.ts';
import type { Reference } from '../model/anchor.ts';
import { RIGHTS, type Right } from '../model/right.ts';
import { workpieceExists } from '../db/collections/workpieces.ts';
import { findComment } from '../db/collections/comments.ts';
import {
  grantsOf,
  isScopeKind,
  placesWhere,
  rightsHeld,
  type Scope,
} from '../db/collections/grants.ts';
import { findGroup, groupsOf, isMemberOfAny, type GroupRecord } from '../db/collections/groups.ts';
import { findRoom, findRooms, roomsContaining, type RoomRecord } from '../db/collections/rooms.ts';
import { findTask, type Assignee, type TaskRecord } from '../db/collections/tasks.ts';

/** Whether the actor holds the right at the target, by a grant there, above it or everywhere. */
export async function may(
  db: Db,
  actor: Actor,
  right: Right,
  target?: Reference,
): Promise<boolean> {
  return (await rightsAt(db, actor, target)).has(right);
}

/** Every right the actor holds at the target; without a target, those that hold everywhere. */
export async function rightsAt(
  db: Db,
  actor: Actor,
  target?: Reference,
): Promise<ReadonlySet<Right>> {
  if (actor.top === true) {
    return new Set(RIGHTS);
  }

  // Without a group there is no grant to hold, so the places need not be looked up.
  const groups = await groupsOf(db, actor.actorId);
  if (groups.length === 0) {
    return new Set();
  }

  const places = new Map<string, Scope>();
  if (target !== undefined) {
    await collectPlaces(db, target, places);
  }

  return rightsHeld(
    db,
    groups.map((group) => group._id),
    [...places.values()],
  );
}

/** Whether the actor may hand these rights on at the place: manage there and each of them held. */
export async function mayHandOn(
  db: Db,
  actor: Actor,
  scope: Scope | undefined,
  rights: readonly Right[],
): Promise<boolean> {
  const held = await rightsAt(db, actor, scope);

  return held.has('manage') && rights.every((right) => held.has(right));
}

/** Taking someone in hands on every grant of the group, so each must be the actor's to give. */
export async function mayAddMember(db: Db, actor: Actor, groupId: ObjectId): Promise<boolean> {
  if (!(await may(db, actor, 'manage', { kind: 'group', id: groupId }))) {
    return false;
  }

  const grants = await grantsOf(db, groupId);
  const allowed = await Promise.all(
    grants.map((grant) => mayHandOn(db, actor, grant.scope, grant.rights)),
  );
  return allowed.every(Boolean);
}

/** Adds the reference and every place above it, each once, so a chain never runs in a circle. */
async function collectPlaces(
  db: Db,
  reference: Reference,
  places: Map<string, Scope>,
): Promise<void> {
  // A kind of the tool is no place, as the service could not enforce a right there.
  if (!isScopeKind(reference.kind) || !(reference.id instanceof ObjectId)) {
    return;
  }
  const key = `${reference.kind}:${reference.id.toHexString()}`;
  if (places.has(key)) {
    return;
  }

  // Taken before the first await, so the parents searched side by side never add it twice.
  const place: Scope = { kind: reference.kind, id: reference.id };
  places.set(key, place);

  const parents = await parentsOf(db, place);
  await Promise.all(parents.map((parent) => collectPlaces(db, parent, places)));
}

/** Right above a place: the rooms of a workpiece, the parent and anchor of a task or comment. */
async function parentsOf(db: Db, place: Scope): Promise<Reference[]> {
  if (place.kind === 'workpiece') {
    const rooms = await roomsContaining(db, place);
    return rooms.map((room) => ({ kind: 'room', id: room._id }));
  }
  if (place.kind === 'task') {
    const task = await findTask(db, place.id);
    return task === null ? [] : above('task', task);
  }
  if (place.kind === 'comment') {
    const comment = await findComment(db, place.id);
    return comment === null ? [] : above('comment', comment);
  }
  // A room and a group have nothing above them but the instance.
  return [];
}

/** The parent of the same kind and the anchor, whichever of the two there is. */
function above(
  kind: 'task' | 'comment',
  entry: { readonly parentId?: ObjectId; readonly anchor?: Reference },
): Reference[] {
  return [
    ...(entry.parentId === undefined ? [] : [{ kind, id: entry.parentId }]),
    ...(entry.anchor === undefined ? [] : [{ kind: entry.anchor.kind, id: entry.anchor.id }]),
  ];
}

/** Open over the socket: edit at it or above, until the gateway can hold a reader to reading. */
export async function mayOpenWorkpiece(
  db: Db,
  actor: Actor,
  workpieceId: ObjectId,
): Promise<boolean> {
  const workpiece: Scope = { kind: 'workpiece', id: workpieceId };

  return (await placeExists(db, workpiece)) && may(db, actor, 'edit', workpiece);
}

/** Every room the actor sees, as one list; the same rule as maySee for a room. */
export async function roomsVisibleTo(db: Db, actor: Actor): Promise<RoomRecord[]> {
  // Whoever sees everywhere sees every room.
  if ((await rightsAt(db, actor)).has('see')) {
    return findRooms(db);
  }

  const groups = await groupsOf(db, actor.actorId);
  const ids = await placesWhere(
    db,
    groups.map((group) => group._id),
    'see',
    'room',
  );
  return findRooms(db, ids);
}

/** Whether a place of the service is there, so no rule answers yes about a key nothing has. */
export async function placeExists(db: Db, place: Scope): Promise<boolean> {
  if (place.kind === 'room') {
    return (await findRoom(db, place.id)) !== null;
  }
  if (place.kind === 'workpiece') {
    return workpieceExists(db, place.id);
  }
  if (place.kind === 'task') {
    return (await findTask(db, place.id)) !== null;
  }
  if (place.kind === 'comment') {
    return (await findComment(db, place.id)) !== null;
  }
  return (await findGroup(db, place.id)) !== null;
}

/** Seen by its members and by whoever holds see at it, since who is in it tells what it opens. */
export async function maySeeGroup(
  db: Db,
  actor: Actor,
  group: Pick<GroupRecord, '_id' | 'members'>,
): Promise<boolean> {
  return (
    group.members.includes(actor.actorId) || may(db, actor, 'see', { kind: 'group', id: group._id })
  );
}

/** May the actor see what a reference names? Only the service's own kinds are decided. */
export async function maySee(db: Db, actor: Actor, target: Reference): Promise<boolean> {
  if (!(target.id instanceof ObjectId)) {
    return true;
  }
  if (target.kind === 'workpiece' || target.kind === 'room') {
    // Seen from a grant at it or above; creating it gives nothing.
    const place: Scope = { kind: target.kind, id: target.id };
    return (await placeExists(db, place)) && may(db, actor, 'see', place);
  }
  if (target.kind === 'group') {
    const group = await findGroup(db, target.id);
    return group !== null && maySeeGroup(db, actor, group);
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
