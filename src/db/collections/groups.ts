import { ObjectId, type Db, type Document } from 'mongodb';

import type { CollectionDefinition } from '../apply.ts';

/** Being in a group, with the moment it started and who arranged it. */
export interface Membership {
  actorId: string;
  addedAt: Date;
  addedBy: string;
}

/** A set of actors, nothing more; what it stands for, a role say, is the business of the tool. */
export interface GroupRecord {
  _id: ObjectId;
  name: string;
  /** What the group means to the docking tool. The service never reads it. */
  settings: Document;
  members: Membership[];
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
        items: {
          bsonType: 'object',
          required: ['actorId', 'addedAt', 'addedBy'],
          properties: {
            actorId: { bsonType: 'string' },
            addedAt: { bsonType: 'date' },
            addedBy: { bsonType: 'string' },
          },
        },
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [{ key: { 'members.actorId': 1 }, name: 'member_actor' }],
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
    members: (input.members ?? []).map((actorId) => ({
      actorId,
      addedAt: now,
      addedBy: input.createdBy,
    })),
    createdAt: now,
    createdBy: input.createdBy,
  };

  await db.collection<GroupRecord>('groups').insertOne(group);
  return group;
}

export async function findGroup(db: Db, id: ObjectId): Promise<GroupRecord | null> {
  return db.collection<GroupRecord>('groups').findOne({ _id: id });
}

export interface NewMember {
  readonly actorId: string;
  readonly addedBy: string;
}

/** Takes an actor in, answers whether that was new; keeps when and by whom, as a role changes. */
export async function addMember(
  db: Db,
  groupId: ObjectId,
  input: NewMember,
  now = new Date(),
): Promise<boolean> {
  const member: Membership = {
    actorId: input.actorId,
    addedAt: now,
    addedBy: input.addedBy,
  };

  const result = await db
    .collection<GroupRecord>('groups')
    .updateOne(
      { _id: groupId, 'members.actorId': { $ne: input.actorId } },
      { $push: { members: member } },
    );

  return result.modifiedCount === 1;
}

export async function removeMember(db: Db, groupId: ObjectId, actorId: string): Promise<boolean> {
  const result = await db
    .collection<GroupRecord>('groups')
    .updateOne({ _id: groupId }, { $pull: { members: { actorId } } });

  return result.modifiedCount === 1;
}

/** Every group this actor is in. */
export async function groupsOf(db: Db, actorId: string): Promise<GroupRecord[]> {
  return db.collection<GroupRecord>('groups').find({ 'members.actorId': actorId }).toArray();
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
    .findOne(
      { _id: { $in: [...groupIds] }, 'members.actorId': actorId },
      { projection: { _id: 1 } },
    );

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
