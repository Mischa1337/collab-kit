import { Binary, ObjectId, type Db, type Document } from 'mongodb';

import type { CollectionDefinition } from '../apply.ts';

/**
 * One row per Y.Doc. The state is the folded shortcut for loading, never the source:
 * the truth is the stream of updates, and it is never deleted.
 */
export interface DocumentRecord {
  _id: ObjectId;
  name: string;
  /** What the tool registered while docking. The service never reads into it. */
  contract: Document;
  /** Folded Yjs state, absent until the document has been folded for the first time. */
  state?: Binary;
  /** The last update folded into state. Absent together with it. */
  stateThrough?: ObjectId;
  createdAt: Date;
  createdBy: string;
  /** When it was folded last. */
  updatedAt?: Date;
}

export const documentsDefinition: CollectionDefinition = {
  name: 'documents',
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

export interface NewDocument {
  readonly name: string;
  readonly createdBy: string;
  readonly contract?: Document;
}

/**
 * Creates an empty document. Deliberately without a starting state: everything that
 * ever happens to it arrives as an update, so the very beginning stays reachable even
 * after the first folding has overwritten the state.
 */
export async function createDocument(
  db: Db,
  input: NewDocument,
  now = new Date(),
): Promise<DocumentRecord> {
  const created: DocumentRecord = {
    _id: new ObjectId(),
    name: input.name,
    contract: input.contract ?? {},
    createdAt: now,
    createdBy: input.createdBy,
  };

  await db.collection<DocumentRecord>('documents').insertOne(created);
  return created;
}

export async function findDocument(db: Db, id: ObjectId): Promise<DocumentRecord | null> {
  return db.collection<DocumentRecord>('documents').findOne({ _id: id });
}

/** Whether the document is there, without loading its folded state along the way. */
export async function documentExists(db: Db, id: ObjectId): Promise<boolean> {
  const found = await db
    .collection<DocumentRecord>('documents')
    .findOne({ _id: id }, { projection: { _id: 1 } });

  return found !== null;
}

export interface Fold {
  readonly documentId: ObjectId;
  /** The state as the caller folded it, produced by Yjs, opaque here. */
  readonly state: Uint8Array;
  /** The last update contained in that state. */
  readonly through: ObjectId;
  /** What stateThrough held when the folding began. Absent means never folded. */
  readonly expected?: ObjectId;
}

/**
 * Replaces the shortcut with a newer one, but only if nobody else folded in the
 * meantime: expected has to still match, otherwise a slower folding would push an
 * older state over a newer one.
 *
 * Losing this race costs nothing. The updates all stay where they are, and the next
 * load simply applies a few more of them.
 */
export async function foldState(db: Db, input: Fold, now = new Date()): Promise<boolean> {
  const result = await db.collection<DocumentRecord>('documents').updateOne(
    {
      _id: input.documentId,
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
