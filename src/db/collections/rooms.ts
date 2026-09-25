import { ObjectId, type Db, type Document } from 'mongodb';

import { referenceProperties, type Reference } from '../../model/anchor.ts';
import type { CollectionDefinition } from '../apply.ts';
import { writeWithEvents, type NewEvent } from './events.ts';

/** Bundles without owning: what it refere1nces lives on its own and may sit in several rooms. */
export interface RoomRecord {
  _id: ObjectId;
  name: string;
  /** Switch positions of the docking tool. The service never reads them. */
  settings: Document;
  /** Whole things only, so no unit; who put them in or took them out, and when, is in events. */
  references: Reference[];
  createdAt: Date;
  createdBy: string;
}

export const roomsDefinition: CollectionDefinition = {
  name: 'rooms',
  schema: {
    bsonType: 'object',
    required: ['name', 'settings', 'references', 'createdAt', 'createdBy'],
    properties: {
      name: { bsonType: 'string' },
      settings: {
        bsonType: 'object',
        description: 'switch positions chosen by the docking tool, deliberately unconstrained',
      },
      references: {
        bsonType: 'array',
        description: 'what the room bundles, pointed at and never owned',
        items: { bsonType: 'object', required: ['kind', 'id'], properties: referenceProperties },
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [{ key: { 'references.id': 1 }, name: 'references_id' }],
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
    references: [],
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

/** Adds a reference if new and records it; not checked, as the kind may be the tool's own. */
export async function addToRoom(
  db: Db,
  roomId: ObjectId,
  input: Addition,
  now = new Date(),
): Promise<boolean> {
  const reference: Reference = { kind: input.kind, id: input.id };

  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<RoomRecord>('rooms')
        .updateOne(
          { _id: roomId, references: { $not: { $elemMatch: reference } } },
          { $push: { references: reference } },
          { session },
        );

      return result.modifiedCount === 1;
    },
    [referenceEvent('reference-added', roomId, reference, input.addedBy)],
    now,
  );
}

export interface Removal extends Reference {
  readonly removedBy: string;
}

/** Takes the reference out again and records it. The thing it pointed at stays untouched. */
export async function removeFromRoom(
  db: Db,
  roomId: ObjectId,
  input: Removal,
  now = new Date(),
): Promise<boolean> {
  const reference: Reference = { kind: input.kind, id: input.id };

  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<RoomRecord>('rooms')
        .updateOne({ _id: roomId }, { $pull: { references: reference } }, { session });

      return result.modifiedCount === 1;
    },
    [referenceEvent('reference-removed', roomId, reference, input.removedBy)],
    now,
  );
}

/** Every room this thing sits in, which is the way back from a workpiece or a group. */
export async function roomsContaining(db: Db, what: Reference): Promise<RoomRecord[]> {
  return db
    .collection<RoomRecord>('rooms')
    .find({ references: { $elemMatch: { kind: what.kind, id: what.id } } })
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

/** The trace of a change to what the room references, anchored at the room. */
function referenceEvent(kind: string, roomId: ObjectId, what: Reference, by: string): NewEvent {
  return { kind, createdBy: by, anchor: { kind: 'room', id: roomId }, detail: { ...what } };
}
