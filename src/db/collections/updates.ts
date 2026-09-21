import { Binary, ObjectId, type Db, type Filter } from 'mongodb';

/**
 * One change to a document, as the bytes Yjs produced. The service never looks into
 * them; what it adds is who changed something and when, which Yjs does not know.
 *
 * Nothing here is ever deleted. Folding a document only writes a shortcut next to
 * these rows, it does not replace them.
 */
export interface UpdateRecord {
  _id: ObjectId;
  documentId: ObjectId;
  update: Binary;
  actorId: string;
  createdAt: Date;
}

export interface NewUpdate {
  readonly documentId: ObjectId;
  readonly update: Uint8Array;
  readonly actorId: string;
}

export async function appendUpdate(
  db: Db,
  input: NewUpdate,
  now = new Date(),
): Promise<UpdateRecord> {
  const record: UpdateRecord = {
    _id: new ObjectId(),
    documentId: input.documentId,
    update: new Binary(input.update),
    actorId: input.actorId,
    createdAt: now,
  };

  await db.collection<UpdateRecord>('updates').insertOne(record);
  return record;
}

/**
 * Every change after the given one, oldest first. Leaving `after` out reads the whole
 * history from the beginning, which is what rebuilding an earlier state needs.
 *
 * The cut runs along _id and not along a timestamp, because ObjectIds are handed out
 * in order while two writes within the same second carry the same date. It holds as
 * long as a single process writes the updates of a document, which the hub assumes
 * anyway by keeping the Y.Doc in memory.
 */
export async function readUpdatesSince(
  db: Db,
  documentId: ObjectId,
  after?: ObjectId,
): Promise<UpdateRecord[]> {
  const filter: Filter<UpdateRecord> =
    after === undefined ? { documentId } : { documentId, _id: { $gt: after } };

  return db.collection<UpdateRecord>('updates').find(filter).sort({ _id: 1 }).toArray();
}

/** The newest change of a document, or undefined while it has none. */
export async function newestUpdate(db: Db, documentId: ObjectId): Promise<ObjectId | undefined> {
  const found = await db
    .collection<UpdateRecord>('updates')
    .findOne({ documentId }, { sort: { _id: -1 }, projection: { _id: 1 } });

  return found?._id;
}
