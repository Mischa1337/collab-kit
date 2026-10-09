import { Binary, ObjectId, type Db, type Filter } from 'mongodb';

import type { CollectionDefinition } from '../apply.ts';

/** One change to a workpiece as Yjs bytes plus who and when; never deleted, not even by a fold. */
export interface UpdateRecord {
  _id: ObjectId;
  workpieceId: ObjectId;
  bytes: Binary;
  /** The Yjs clients with new pieces in it; the first change with one names whose they are. */
  clients: number[];
  createdBy: string;
  createdAt: Date;
}

export const updatesDefinition: CollectionDefinition = {
  name: 'updates',
  schema: {
    bsonType: 'object',
    required: ['workpieceId', 'bytes', 'clients', 'createdBy', 'createdAt'],
    properties: {
      workpieceId: { bsonType: 'objectId' },
      bytes: { bsonType: 'binData', description: 'the Yjs update, opaque to the service' },
      clients: {
        bsonType: 'array',
        // Yjs client ids reach 2^32, beyond what an int holds.
        items: { bsonType: 'number' },
        description: 'Yjs clients with new pieces in this change',
      },
      createdBy: { bsonType: 'string', description: 'D6.19, author on every single change' },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [
    { key: { workpieceId: 1, _id: 1 }, name: 'workpiece_stream' },
    { key: { workpieceId: 1, clients: 1, _id: 1 }, name: 'workpiece_clients' },
  ],
};

export interface NewUpdate {
  readonly workpieceId: ObjectId;
  readonly bytes: Uint8Array;
  readonly clients: readonly number[];
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
    clients: [...input.clients],
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

/** Changes up to and including the given one, oldest first; the chain to an earlier state. */
export async function readUpdatesUntil(
  db: Db,
  workpieceId: ObjectId,
  until: ObjectId,
): Promise<UpdateRecord[]> {
  return db
    .collection<UpdateRecord>('updates')
    .find({ workpieceId, _id: { $lte: until } })
    .sort({ _id: 1 })
    .toArray();
}

/** Whether the change belongs to this workpiece, so a point from outside can be trusted. */
export async function isUpdateOf(
  db: Db,
  workpieceId: ObjectId,
  updateId: ObjectId,
): Promise<boolean> {
  const found = await db
    .collection<UpdateRecord>('updates')
    .findOne({ _id: updateId, workpieceId }, { projection: { _id: 1 } });

  return found !== null;
}

/** Whose pieces of these Yjs clients are: the author of the first change that brought one. */
export async function creatorsOf(
  db: Db,
  workpieceId: ObjectId,
  clientIds: readonly number[],
): Promise<Map<number, string>> {
  // One lookup per client, each answered by the index alone.
  const found = await Promise.all(
    clientIds.map(async (client) => {
      const first = await db
        .collection<UpdateRecord>('updates')
        .findOne(
          { workpieceId, clients: client },
          { sort: { _id: 1 }, projection: { createdBy: 1 } },
        );
      return [client, first?.createdBy] as const;
    }),
  );

  // A client no change brought stays out, so the caller sees whose author is unknown.
  return new Map(
    found.filter((entry): entry is readonly [number, string] => entry[1] !== undefined),
  );
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
