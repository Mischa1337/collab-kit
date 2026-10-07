import { ObjectId, type Db, type Document } from 'mongodb';

import { defined } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';
import { writeReturningEvents, writeWithEvents, type NewEvent } from './events.ts';
import { removeGrantsOfGroup } from './grants.ts';

/** A set of actors, nothing more; what it stands for, a role say, is the business of the tool. */
export interface GroupRecord {
  _id: ObjectId;
  name: string;
  /** What the group means to the docking tool. The service never reads it. */
  settings: Document;
  /** Actor keys; who put them in or took them out, and when, is kept in events. */
  members: string[];
  createdAt: Date;
  createdBy: string;
}

export const groupsDefinition: CollectionDefinition = {
  name: 'groups',
  schema: {
    bsonType: 'object',
    required: ['name', 'settings', 'members', 'createdAt', 'createdBy'],
    properties: {
      name: { bsonType: 'string' },
      settings: {
        bsonType: 'object',
        description: 'what the group stands for in the docking tool, deliberately unconstrained',
      },
      members: {
        bsonType: 'array',
        description: 'opaque actor keys, no object and no task ever hangs on a group',
        items: { bsonType: 'string' },
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [{ key: { members: 1 }, name: 'members' }],
};

export interface NewGroup {
  readonly name: string;
  readonly createdBy: string;
  readonly settings?: Document;
  /** Actor keys the group starts with, all joining at the moment it is created. */
  readonly members?: readonly string[];
}

export async function createGroup(db: Db, input: NewGroup, now = new Date()): Promise<GroupRecord> {
  const group: GroupRecord = {
    _id: new ObjectId(),
    name: input.name,
    settings: input.settings ?? {},
    members: [...new Set(input.members ?? [])],
    createdAt: now,
    createdBy: input.createdBy,
  };

  await writeWithEvents(
    db,
    async (session) => {
      await db.collection<GroupRecord>('groups').insertOne(group, { session });
      return true;
    },
    group.members.map((actorId) =>
      memberEvent('member-added', group._id, actorId, input.createdBy),
    ),
    now,
  );

  return group;
}

export async function findGroup(db: Db, id: ObjectId): Promise<GroupRecord | null> {
  return db.collection<GroupRecord>('groups').findOne({ _id: id });
}

export interface NewMember {
  readonly actorId: string;
  readonly addedBy: string;
}

/** Takes an actor in and records it; answers whether that was new. */
export async function addMember(
  db: Db,
  groupId: ObjectId,
  input: NewMember,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<GroupRecord>('groups')
        .updateOne({ _id: groupId }, { $addToSet: { members: input.actorId } }, { session });

      return result.modifiedCount === 1;
    },
    [memberEvent('member-added', groupId, input.actorId, input.addedBy)],
    now,
  );
}

export interface MemberRemoval {
  readonly actorId: string;
  readonly removedBy: string;
}

/** Lets an actor go and records it; answers whether they were in. */
export async function removeMember(
  db: Db,
  groupId: ObjectId,
  input: MemberRemoval,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<GroupRecord>('groups')
        .updateOne({ _id: groupId }, { $pull: { members: input.actorId } }, { session });

      return result.modifiedCount === 1;
    },
    [memberEvent('member-removed', groupId, input.actorId, input.removedBy)],
    now,
  );
}

/** These groups, or every group when no keys are named. */
export async function findGroups(db: Db, ids?: readonly ObjectId[]): Promise<GroupRecord[]> {
  const filter = ids === undefined ? {} : { _id: { $in: [...ids] } };

  return db.collection<GroupRecord>('groups').find(filter).toArray();
}

/** Every group this actor is in. */
export async function groupsOf(db: Db, actorId: string): Promise<GroupRecord[]> {
  return db.collection<GroupRecord>('groups').find({ members: actorId }).toArray();
}

/** Whether the actor is in at least one of these groups, as a single yes-or-no query. */
export async function isMemberOfAny(
  db: Db,
  groupIds: readonly ObjectId[],
  actorId: string,
): Promise<boolean> {
  if (groupIds.length === 0) {
    return false;
  }

  const found = await db
    .collection<GroupRecord>('groups')
    .findOne({ _id: { $in: [...groupIds] }, members: actorId }, { projection: { _id: 1 } });

  return found !== null;
}

/** Replaces what the group stands for in the docking tool. Replaces, see setRoomSettings. */
export async function setGroupSettings(
  db: Db,
  groupId: ObjectId,
  settings: Document,
): Promise<boolean> {
  const result = await db
    .collection<GroupRecord>('groups')
    .updateOne({ _id: groupId }, { $set: { settings } });

  return result.matchedCount === 1;
}

export interface GroupRenaming {
  readonly name: string;
  readonly renamedBy: string;
  readonly reason?: string;
}

/** Gives the group a new name and records it; the same name leaves no trace. */
export async function renameGroup(
  db: Db,
  groupId: ObjectId,
  input: GroupRenaming,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<GroupRecord>('groups')
        .updateOne(
          { _id: groupId, name: { $ne: input.name } },
          { $set: { name: input.name } },
          { session },
        );
      return result.modifiedCount === 1;
    },
    [groupEvent('group-renamed', groupId, input.renamedBy, { to: input.name }, input.reason)],
    now,
  );
}

export interface GroupDeletion {
  readonly deletedBy: string;
  readonly reason?: string;
}

/** Deletes the group with its grants and those held at it; a task given to it keeps the entry. */
export async function deleteGroup(
  db: Db,
  groupId: ObjectId,
  input: GroupDeletion,
  now = new Date(),
): Promise<boolean> {
  return writeReturningEvents(
    db,
    async (session) => {
      const group = await db
        .collection<GroupRecord>('groups')
        .findOneAndDelete({ _id: groupId }, { session });
      if (group === null) {
        return [];
      }

      // What it held goes with it, and rights at it would hold at nothing.
      const removal = { removedBy: input.deletedBy, ...defined({ reason: input.reason }) };
      const removed = await removeGrantsOfGroup(db, groupId, removal, session);
      return [
        ...removed,
        groupEvent('group-deleted', groupId, input.deletedBy, { name: group.name }, input.reason),
      ];
    },
    now,
  );
}

/** The trace of a change to the group itself, anchored at the group. */
function groupEvent(
  kind: string,
  groupId: ObjectId,
  by: string,
  detail: Document,
  reason: string | undefined,
): NewEvent {
  return {
    kind,
    createdBy: by,
    anchor: { kind: 'group', id: groupId },
    detail,
    ...defined({ reason }),
  };
}

/** The trace of a membership change, anchored at the group. */
function memberEvent(kind: string, groupId: ObjectId, actorId: string, by: string): NewEvent {
  return { kind, createdBy: by, anchor: { kind: 'group', id: groupId }, detail: { actorId } };
}
