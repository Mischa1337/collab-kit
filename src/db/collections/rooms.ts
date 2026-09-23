import { ObjectId, type Db, type Document } from 'mongodb';

import type { Reference } from '../../anchor.ts';

/**
 * A reference plus when it was put into the room and by whom. A room bundles whole
 * things, never a unit inside one, which is why this is a Reference and not an Anchor.
 */
export interface Containment extends Reference {
  addedAt: Date;
  addedBy: string;
}

/**
 * A room bundles, it does not own. Everything in `contains` exists on its own and may
 * sit in several rooms at once, which is why removing a room removes nothing else.
 *
 * Who may do what is not decided here. A group in the room is the role, and which
 * roles exist is the business of the docking tool.
 */
export interface Room {
  _id: ObjectId;
  name: string;
  /** Switch positions of the docking tool. The service never reads them. */
  settings: Document;
  contains: Containment[];
  createdAt: Date;
  createdBy: string;
}

export interface NewRoom {
  readonly name: string;
  readonly createdBy: string;
  readonly settings?: Document;
}

export async function createRoom(db: Db, input: NewRoom, now = new Date()): Promise<Room> {
  const room: Room = {
    _id: new ObjectId(),
    name: input.name,
    settings: input.settings ?? {},
    contains: [],
    createdAt: now,
    createdBy: input.createdBy,
  };

  await db.collection<Room>('rooms').insertOne(room);
  return room;
}

export async function findRoom(db: Db, id: ObjectId): Promise<Room | null> {
  return db.collection<Room>('rooms').findOne({ _id: id });
}

export interface Addition extends Reference {
  readonly addedBy: string;
}

/**
 * Puts a reference into the room and answers whether it was new. The condition sits
 * in the filter and not in a read beforehand, so two people adding the same thing at
 * the same moment still end up with one entry.
 *
 * Nothing is checked for existence. A reference that points nowhere costs nothing,
 * and checking only the kinds the service happens to know would be a rule that holds
 * for documents and quietly does not hold for everything a tool brings along.
 */
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

  const result = await db.collection<Room>('rooms').updateOne(
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
    .collection<Room>('rooms')
    .updateOne({ _id: roomId }, { $pull: { contains: { kind: what.kind, id: what.id } } });

  return result.modifiedCount === 1;
}

/** Every room this thing sits in, which is the way back from a document or a group. */
export async function roomsContaining(db: Db, what: Reference): Promise<Room[]> {
  return db
    .collection<Room>('rooms')
    .find({ contains: { $elemMatch: { kind: what.kind, id: what.id } } })
    .toArray();
}

/**
 * Replaces the switch positions of the docking tool. Replaces and does not merge:
 * the service does not read this object, so it cannot tell which of its keys the
 * tool meant to drop.
 */
export async function setRoomSettings(
  db: Db,
  roomId: ObjectId,
  settings: Document,
): Promise<boolean> {
  const result = await db
    .collection<Room>('rooms')
    .updateOne({ _id: roomId }, { $set: { settings } });

  return result.matchedCount === 1;
}
