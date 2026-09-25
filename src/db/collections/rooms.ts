import { ObjectId, type Db, type Document } from 'mongodb';

import { referenceProperties, type Reference } from '../../model/anchor.ts';
import type { CollectionDefinition } from '../apply.ts';

/** A reference plus when and by whom it was put in; whole things only, so no Anchor with a unit. */
export interface Containment extends Reference {
  addedAt: Date;
  addedBy: string;
}

/** Bundles without owning: what it contains lives on its own and may sit in several rooms. */
export interface RoomRecord {
  _id: ObjectId;
  name: string;
  /** Switch positions of the docking tool. The service never reads them. */
  settings: Document;
  contains: Containment[];
  createdAt: Date;
  createdBy: string;
}

export const roomsDefinition: CollectionDefinition = {
  name: 'rooms',
  schema: {
    bsonType: 'object',
    required: ['name', 'settings', 'contains', 'createdAt', 'createdBy'],
    properties: {
      name: { bsonType: 'string' },
      settings: {
        bsonType: 'object',
        description: 'switch positions chosen by the docking tool, deliberately unconstrained',
      },
      contains: {
        bsonType: 'array',
        description: 'what the room bundles, pointed at and never owned',
        items: {
          bsonType: 'object',
          required: ['kind', 'id', 'addedAt', 'addedBy'],
          properties: {
            ...referenceProperties,
            addedAt: { bsonType: 'date' },
            addedBy: { bsonType: 'string' },
          },
        },
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [{ key: { 'contains.id': 1 }, name: 'contains_id' }],
};

export interface NewRoom {
  readonly name: string;
  readonly createdBy: string;
  readonly settings?: Document;
}

export async function createRoom(db: Db, input: NewRoom, now = new Date()): Promise<RoomRecord> {
  const room: RoomRecord = {
    _id: new ObjectId(),
    name: input.name,
    settings: input.settings ?? {},
    contains: [],
    createdAt: now,
    createdBy: input.createdBy,
  };

  await db.collection<RoomRecord>('rooms').insertOne(room);
  return room;
}

export async function findRoom(db: Db, id: ObjectId): Promise<RoomRecord | null> {
  return db.collection<RoomRecord>('rooms').findOne({ _id: id });
}

export interface Addition extends Reference {
  readonly addedBy: string;
}

/** Adds a reference if new, atomically; no existence check, as the kind may be the tool's own. */
export async function addToRoom(
  db: Db,
  roomId: ObjectId,
  input: Addition,
  now = new Date(),
): Promise<boolean> {
  const entry: Containment = {
    kind: input.kind,
    id: input.id,
    addedAt: now,
    addedBy: input.addedBy,
  };

  const result = await db.collection<RoomRecord>('rooms').updateOne(
    {
      _id: roomId,
      contains: { $not: { $elemMatch: { kind: input.kind, id: input.id } } },
    },
    { $push: { contains: entry } },
  );

  return result.modifiedCount === 1;
}

/** Takes the reference out again. The thing it pointed at stays untouched. */
export async function removeFromRoom(db: Db, roomId: ObjectId, what: Reference): Promise<boolean> {
  const result = await db
    .collection<RoomRecord>('rooms')
    .updateOne({ _id: roomId }, { $pull: { contains: { kind: what.kind, id: what.id } } });

  return result.modifiedCount === 1;
}

/** Every room this thing sits in, which is the way back from a workpiece or a group. */
export async function roomsContaining(db: Db, what: Reference): Promise<RoomRecord[]> {
  return db
    .collection<RoomRecord>('rooms')
    .find({ contains: { $elemMatch: { kind: what.kind, id: what.id } } })
    .toArray();
}

/** Replaces the switch positions, never merges: unread here, so which keys to drop is unknown. */
export async function setRoomSettings(
  db: Db,
  roomId: ObjectId,
  settings: Document,
): Promise<boolean> {
  const result = await db
    .collection<RoomRecord>('rooms')
    .updateOne({ _id: roomId }, { $set: { settings } });

  return result.matchedCount === 1;
}
