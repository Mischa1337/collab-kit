import { Binary, ObjectId, type Db, type Document } from 'mongodb';

import type { CollectionDefinition } from '../apply.ts';

/** One row per Y.Doc; state is only a loading shortcut, the truth is the update stream. */
export interface WorkpieceRecord {
  _id: ObjectId;
  name: string;
  /** What the tool registered while docking. The service never reads into it. */
  contract: Document;
  /** Folded Yjs state, absent until the workpiece has been folded for the first time. */
  state?: Binary;
  /** The last update folded into state. Absent together with it. */
  stateThrough?: ObjectId;
  createdAt: Date;
  createdBy: string;
  /** When it was folded last. */
  updatedAt?: Date;
}

export const workpiecesDefinition: CollectionDefinition = {
  name: 'workpieces',
  schema: {
    bsonType: 'object',
    required: ['name', 'createdAt', 'createdBy'],
    properties: {
      name: { bsonType: 'string' },
      contract: {
        bsonType: 'object',
        description: 'what the tool registered while docking, deliberately unconstrained',
      },
      state: {
        bsonType: 'binData',
        description: 'folded Yjs state, a shortcut for loading, absent until first folded',
      },
      stateThrough: {
        bsonType: 'objectId',
        description: 'the last update folded into state, absent together with it',
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
      updatedAt: { bsonType: 'date', description: 'when it was folded last' },
    },
  },
};

export interface NewWorkpiece {
  readonly name: string;
  readonly createdBy: string;
  readonly contract?: Document;
}

/** Creates an empty workpiece without a start state: every change, even the first, is an update. */
export async function createWorkpiece(
  db: Db,
  input: NewWorkpiece,
  now = new Date(),
): Promise<WorkpieceRecord> {
  const created: WorkpieceRecord = {
    _id: new ObjectId(),
    name: input.name,
    contract: input.contract ?? {},
    createdAt: now,
    createdBy: input.createdBy,
  };

  await db.collection<WorkpieceRecord>('workpieces').insertOne(created);
  return created;
}

export async function findWorkpiece(db: Db, id: ObjectId): Promise<WorkpieceRecord | null> {
  return db.collection<WorkpieceRecord>('workpieces').findOne({ _id: id });
}

/** Whether the workpiece is there, without loading its folded state along the way. */
export async function workpieceExists(db: Db, id: ObjectId): Promise<boolean> {
  const found = await db
    .collection<WorkpieceRecord>('workpieces')
    .findOne({ _id: id }, { projection: { _id: 1 } });

  return found !== null;
}

export interface Fold {
  readonly workpieceId: ObjectId;
  /** The state as the caller folded it, produced by Yjs, opaque here. */
  readonly state: Uint8Array;
  /** The last update contained in that state. */
  readonly through: ObjectId;
  /** What stateThrough held when the folding began. Absent means never folded. */
  readonly expected?: ObjectId;
}

/** Swaps in a newer state only if nobody folded meanwhile; losing the race costs nothing. */
export async function foldState(db: Db, input: Fold, now = new Date()): Promise<boolean> {
  const result = await db.collection<WorkpieceRecord>('workpieces').updateOne(
    {
      _id: input.workpieceId,
      stateThrough: input.expected ?? { $exists: false },
    },
    {
      $set: {
        state: new Binary(input.state),
        stateThrough: input.through,
        updatedAt: now,
      },
    },
  );

  return result.matchedCount === 1;
}
