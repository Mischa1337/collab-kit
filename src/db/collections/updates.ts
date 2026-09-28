import { Binary, ObjectId, type Db, type Filter } from 'mongodb';

import type { CollectionDefinition } from '../apply.ts';

/** One change to a workpiece as Yjs bytes plus who and when; never deleted, not even by a fold. */
export interface UpdateRecord {
  _id: ObjectId;
  workpieceId: ObjectId;
  bytes: Binary;
  createdBy: string;
  createdAt: Date;
}

export const updatesDefinition: CollectionDefinition = {
  name: 'updates',
  schema: {
    bsonType: 'object',
    required: ['workpieceId', 'bytes', 'createdBy', 'createdAt'],
    properties: {
      workpieceId: { bsonType: 'objectId' },
      bytes: { bsonType: 'binData', description: 'the Yjs update, opaque to the service' },
      createdBy: { bsonType: 'string', description: 'D6.19, author on every single change' },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { workpieceId: 1, _id: 1 }, name: 'workpiece_stream' }],
};

export interface NewUpdate {
  readonly workpieceId: ObjectId;
  readonly bytes: Uint8Array;
  readonly createdBy: string;
}

export async function appendUpdate(
  db: Db,
  input: NewUpdate,
  now = new Date(),
): Promise<UpdateRecord> {
  const record: UpdateRecord = {
    _id: new ObjectId(),
    workpieceId: input.workpieceId,
    bytes: new Binary(input.bytes),
    createdBy: input.createdBy,
    createdAt: now,
  };

  await db.collection<UpdateRecord>('updates').insertOne(record);
  return record;
}

/** Changes after the given one (all without it), oldest first; _id keeps order with one writer. */
export async function readUpdatesSince(
  db: Db,
  workpieceId: ObjectId,
  since?: ObjectId,
): Promise<UpdateRecord[]> {
  return db
    .collection<UpdateRecord>('updates')
    .find(after(workpieceId, since))
    .sort({ _id: 1 })
    .toArray();
}

/** One change as the service tells of it: who, when and how many bytes, never the bytes. */
export interface UpdateSummary {
  _id: ObjectId;
  createdBy: string;
  createdAt: Date;
  bytes: number;
}

/** Like readUpdatesSince, but MongoDB counts the bytes instead of sending them; limit caps it. */
export async function summarizeUpdatesSince(
  db: Db,
  workpieceId: ObjectId,
  since?: ObjectId,
  limit?: number,
): Promise<UpdateSummary[]> {
  const found = db
    .collection<UpdateRecord>('updates')
    .find<UpdateSummary>(after(workpieceId, since), {
      projection: { createdBy: 1, createdAt: 1, bytes: { $binarySize: '$bytes' } },
    })
    .sort({ _id: 1 });

  return limit === undefined ? found.toArray() : found.limit(limit).toArray();
}

/** The changes of a workpiece after the given one, or all of them. */
function after(workpieceId: ObjectId, since: ObjectId | undefined): Filter<UpdateRecord> {
  return since === undefined ? { workpieceId } : { workpieceId, _id: { $gt: since } };
}

/** The id of the newest change of a workpiece, or undefined while it has none. */
export async function newestUpdateId(db: Db, workpieceId: ObjectId): Promise<ObjectId | undefined> {
  const found = await db
    .collection<UpdateRecord>('updates')
    .findOne({ workpieceId }, { sort: { _id: -1 }, projection: { _id: 1 } });

  return found?._id;
}
