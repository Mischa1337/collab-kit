/** Every rule on who may see or change what; routes and the gateway only ask. */

import { ObjectId, type Db } from 'mongodb';

import type { Actor } from '../model/actor.ts';
import type { Reference } from '../model/anchor.ts';
import { RIGHTS, type Right } from '../model/right.ts';
import { workpieceExists } from '../db/collections/workpieces.ts';
import { findComment, type CommentRecord } from '../db/collections/comments.ts';
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
    // As visible as what it is about, or by a grant at it or at a comment it answers.
    const comment = await findComment(db, target.id);
    return (
      comment !== null &&
      ((await maySee(db, actor, comment.anchor)) || may(db, actor, 'see', target))
    );
  }
  if (target.kind === 'task') {
    const task = await findTask(db, target.id);
    return task !== null && maySeeTask(db, actor, task);
  }
  return true;
}

/** A task is seen by whom it is given to, by a grant at it, and through its anchor or parent. */
async function maySeeTask(db: Db, actor: Actor, task: TaskRecord): Promise<boolean> {
  if (await isAssigned(db, actor, task)) {
    return true;
  }
  if (await may(db, actor, 'see', { kind: 'task', id: task._id })) {
    return true;
  }
  // Through maySee, so whom the anchor or parent task is given to sees this one too.
  if (task.anchor !== undefined && (await maySee(db, actor, task.anchor))) {
    return true;
  }
  return task.parentId !== undefined && maySee(db, actor, { kind: 'task', id: task.parentId });
}

/** Whether the task is given to the actor or to one of their groups; creating it gives nothing. */
export async function isAssigned(
  db: Db,
  actor: Actor,
  task: Pick<TaskRecord, 'assignees'>,
): Promise<boolean> {
  const { assignees } = task;

  if (assignees.some((entry) => entry.kind === 'actor' && entry.id === actor.actorId)) {
    return true;
  }
  // One query for all groups on the task; none at all asks nothing.
  const groupIds = assignees.filter((entry) => entry.kind === 'group').map((entry) => entry.id);
  return isMemberOfAny(db, groupIds, actor.actorId);
}

/** Every assignee isAssigned lets the actor count as: themselves and each of their groups. */
export async function assigneesFor(db: Db, actor: Actor): Promise<[Assignee, ...Assignee[]]> {
  const groups = await groupsOf(db, actor.actorId);

  return [
    { kind: 'actor', id: actor.actorId },
    ...groups.map((group) => ({ kind: 'group' as const, id: group._id })),
  ];
}

/** Whether the actor holds the right wherever something new will hang, or everywhere at nothing. */
export async function mayCreateAt(
  db: Db,
  actor: Actor,
  right: Right,
  places: readonly Reference[],
): Promise<boolean> {
  if (places.length === 0) {
    return may(db, actor, right);
  }

  // At each of them, so hanging it under a parent opens no way around its anchor.
  const allowed = await Promise.all(places.map((place) => may(db, actor, right, place)));
  return allowed.every(Boolean);
}

/** A state the tool named a decision takes decide; any other whom it is given to, or plan. */
export async function maySetTaskState(
  db: Db,
  actor: Actor,
  task: TaskRecord,
  state: string,
  decisions: readonly string[],
): Promise<boolean> {
  const at: Reference = { kind: 'task', id: task._id };

  if (decisions.includes(state)) {
    return may(db, actor, 'decide', at);
  }
  return (await isAssigned(db, actor, task)) || may(db, actor, 'plan', at);
}

/** Giving and taking a task is planning. */
export async function mayAssignTask(db: Db, actor: Actor, taskId: ObjectId): Promise<boolean> {
  return may(db, actor, 'plan', { kind: 'task', id: taskId });
}

/** Asked for each entry: any actor key, as the service cannot know them; a group only if seen. */
export async function mayAssignTo(db: Db, actor: Actor, assignee: Assignee): Promise<boolean> {
  return assignee.kind === 'actor' || maySee(db, actor, assignee);
}

/** Whether an assignee sees what the task is about; only a group, a person's token is unknown. */
export async function assigneeSees(
  db: Db,
  assignee: Assignee,
  anchor: Reference | undefined,
): Promise<boolean> {
  if (assignee.kind === 'actor' || anchor === undefined) {
    return true;
  }

  const places = new Map<string, Scope>();
  await collectPlaces(db, anchor, places);
  return (await rightsHeld(db, [assignee.id], [...places.values()])).has('see');
}

/** The words are the author's to change while they may speak there; anyone else's take manage. */
export async function mayChangeComment(
  db: Db,
  actor: Actor,
  comment: Pick<CommentRecord, '_id' | 'createdBy'>,
): Promise<boolean> {
  const at: Reference = { kind: 'comment', id: comment._id };

  if (comment.createdBy === actor.actorId && (await may(db, actor, 'speak', at))) {
    return true;
  }
  return may(db, actor, 'manage', at);
}

/** A state the tool named a decision takes decide; any other whoever may speak there. */
export async function maySetCommentState(
  db: Db,
  actor: Actor,
  commentId: ObjectId,
  state: string,
  decisions: readonly string[],
): Promise<boolean> {
  const right: Right = decisions.includes(state) ? 'decide' : 'speak';

  return may(db, actor, right, { kind: 'comment', id: commentId });
}
