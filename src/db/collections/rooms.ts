import { ObjectId, type Db, type Document } from 'mongodb';

import { defined } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';
import { writeReturningEvents, writeWithEvents, type NewEvent } from './events.ts';
import { removeGrantsAt } from './grants.ts';

/** Bundles without owning: its workpieces live on their own and may sit in several rooms. */
export interface RoomRecord {
  _id: ObjectId;
  name: string;
  /** Switch positions of the docking tool. The service never reads them. */
  settings: Document;
  /** Only workpieces, as only to them rights flow down; who moved them, and when, is in events. */
  workpieces: ObjectId[];
  createdAt: Date;
  createdBy: string;
}

export const roomsDefinition: CollectionDefinition = {
  name: 'rooms',
  schema: {
    bsonType: 'object',
    required: ['name', 'settings', 'workpieces', 'createdAt', 'createdBy'],
    properties: {
      name: { bsonType: 'string' },
      settings: {
        bsonType: 'object',
        description: 'switch positions chosen by the docking tool, deliberately unconstrained',
      },
      workpieces: {
        bsonType: 'array',
        description: 'the workpieces the room bundles, pointed at and never owned',
        items: { bsonType: 'objectId' },
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [{ key: { workpieces: 1 }, name: 'workpieces' }],
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
    workpieces: [],
    createdAt: now,
    createdBy: input.createdBy,
  };

  await db.collection<RoomRecord>('rooms').insertOne(room);
  return room;
}

export async function findRoom(db: Db, id: ObjectId): Promise<RoomRecord | null> {
  return db.collection<RoomRecord>('rooms').findOne({ _id: id });
}

export interface Addition {
  readonly workpieceId: ObjectId;
  readonly addedBy: string;
}

/** Adds a workpiece if new and records it; whether it is there the route checks. */
export async function addToRoom(
  db: Db,
  roomId: ObjectId,
  input: Addition,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<RoomRecord>('rooms')
        .updateOne({ _id: roomId }, { $addToSet: { workpieces: input.workpieceId } }, { session });

      return result.modifiedCount === 1;
    },
    [workpieceEvent('workpiece-added', roomId, input.workpieceId, input.addedBy)],
    now,
  );
}

export interface Removal {
  readonly workpieceId: ObjectId;
  readonly removedBy: string;
}

/** Takes the workpiece out again and records it. The workpiece itself stays untouched. */
export async function removeFromRoom(
  db: Db,
  roomId: ObjectId,
  input: Removal,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<RoomRecord>('rooms')
        .updateOne({ _id: roomId }, { $pull: { workpieces: input.workpieceId } }, { session });

      return result.modifiedCount === 1;
    },
    [workpieceEvent('workpiece-removed', roomId, input.workpieceId, input.removedBy)],
    now,
  );
}

/** Every room this workpiece sits in, which is the way back from it. */
export async function roomsContaining(db: Db, workpieceId: ObjectId): Promise<RoomRecord[]> {
  return db.collection<RoomRecord>('rooms').find({ workpieces: workpieceId }).toArray();
}

/** These rooms, or every room when no keys are named. */
export async function findRooms(db: Db, ids?: readonly ObjectId[]): Promise<RoomRecord[]> {
  const filter = ids === undefined ? {} : { _id: { $in: [...ids] } };

  return db.collection<RoomRecord>('rooms').find(filter).toArray();
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

export interface RoomRenaming {
  readonly name: string;
  readonly renamedBy: string;
  readonly reason?: string;
}

/** Gives the room a new name and records it; the same name leaves no trace. */
export async function renameRoom(
  db: Db,
  roomId: ObjectId,
  input: RoomRenaming,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<RoomRecord>('rooms')
        .updateOne(
          { _id: roomId, name: { $ne: input.name } },
          { $set: { name: input.name } },
          { session },
        );
      return result.modifiedCount === 1;
    },
    [roomEvent('room-renamed', roomId, input.renamedBy, { to: input.name }, input.reason)],
    now,
  );
}

export interface RoomDeletion {
  readonly deletedBy: string;
  readonly reason?: string;
}

/** Deletes the room and the grants at it; what it bundled stays, and so do its events. */
export async function deleteRoom(
  db: Db,
  roomId: ObjectId,
  input: RoomDeletion,
  now = new Date(),
): Promise<boolean> {
  return writeReturningEvents(
    db,
    async (session) => {
      const room = await db
        .collection<RoomRecord>('rooms')
        .findOneAndDelete({ _id: roomId }, { session });
      if (room === null) {
        return [];
      }

      // Rights at a place that is gone would hold at nothing, so they go with it.
      const removal = { removedBy: input.deletedBy, ...defined({ reason: input.reason }) };
      const removed = await removeGrantsAt(db, { kind: 'room', id: roomId }, removal, session);
      return [
        ...removed,
        roomEvent('room-deleted', roomId, input.deletedBy, { name: room.name }, input.reason),
      ];
    },
    now,
  );
}

/** The trace of a change to the room itself, anchored at the room. */
function roomEvent(
  kind: string,
  roomId: ObjectId,
  by: string,
  detail: Document,
  reason: string | undefined,
): NewEvent {
  return {
    kind,
    createdBy: by,
    anchor: { kind: 'room', id: roomId },
    detail,
    ...defined({ reason }),
  };
}

/** The trace of a workpiece put in or taken out, anchored at the room. */
function workpieceEvent(
  kind: string,
  roomId: ObjectId,
  workpieceId: ObjectId,
  by: string,
): NewEvent {
  return { kind, createdBy: by, anchor: { kind: 'room', id: roomId }, detail: { workpieceId } };
}
