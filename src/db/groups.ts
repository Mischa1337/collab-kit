import { ObjectId, type Db, type Document } from 'mongodb';

/** Being in a group, with the moment it started and who arranged it. */
export interface Membership {
  actorId: string;
  joinedAt: Date;
  addedBy: string;
}

/**
 * A group is a set of actors and nothing else. No object, no task and no utterance
 * hangs on it: a task may be addressed to a group, but then the task points at the
 * group and not the other way round.
 *
 * What a group stands for is not decided here. A group in a room is the role, and
 * which groups exist is the business of the docking tool.
 */
export interface Group {
  _id: ObjectId;
  name: string;
  /** What the group means to the docking tool. The service never reads it. */
  settings: Document;
  members: Membership[];
  createdAt: Date;
  createdBy: string;
}

export interface NewGroup {
  readonly name: string;
  readonly createdBy: string;
  readonly settings?: Document;
  /** Actor keys the group starts with, all joining at the moment it is created. */
  readonly members?: readonly string[];
}

export async function createGroup(db: Db, input: NewGroup, now = new Date()): Promise<Group> {
  const group: Group = {
    _id: new ObjectId(),
    name: input.name,
    settings: input.settings ?? {},
    members: (input.members ?? []).map((actorId) => ({
      actorId,
      joinedAt: now,
      addedBy: input.createdBy,
    })),
    createdAt: now,
    createdBy: input.createdBy,
  };

  await db.collection<Group>('groups').insertOne(group);
  return group;
}

export async function findGroup(db: Db, id: ObjectId): Promise<Group | null> {
  return db.collection<Group>('groups').findOne({ _id: id });
}

export interface NewMember {
  readonly actorId: string;
  readonly addedBy: string;
}

/**
 * Takes an actor in and answers whether that was new. Joining a group is a change of
 * role, which is why the moment is kept and not only the fact.
 */
export async function addMember(
  db: Db,
  groupId: ObjectId,
  input: NewMember,
  now = new Date(),
): Promise<boolean> {
  const member: Membership = {
    actorId: input.actorId,
    joinedAt: now,
    addedBy: input.addedBy,
  };

  const result = await db
    .collection<Group>('groups')
    .updateOne(
      { _id: groupId, 'members.actorId': { $ne: input.actorId } },
      { $push: { members: member } },
    );

  return result.modifiedCount === 1;
}

export async function removeMember(db: Db, groupId: ObjectId, actorId: string): Promise<boolean> {
  const result = await db
    .collection<Group>('groups')
    .updateOne({ _id: groupId }, { $pull: { members: { actorId } } });

  return result.modifiedCount === 1;
}

/** Every group this actor is in. */
export async function groupsOf(db: Db, actorId: string): Promise<Group[]> {
  return db
    .collection<Group>('groups')
    .find({ members: { $elemMatch: { actorId } } })
    .toArray();
}

/**
 * Whether the actor is in at least one of these groups. Asked as a single question,
 * because the caller wants a yes or no and not the groups themselves.
 */
export async function isMemberOfAny(
  db: Db,
  groupIds: readonly ObjectId[],
  actorId: string,
): Promise<boolean> {
  if (groupIds.length === 0) {
    return false;
  }

  const found = await db
    .collection<Group>('groups')
    .findOne(
      { _id: { $in: [...groupIds] }, members: { $elemMatch: { actorId } } },
      { projection: { _id: 1 } },
    );

  return found !== null;
}
