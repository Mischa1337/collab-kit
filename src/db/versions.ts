import { Binary, ObjectId, type Db } from 'mongodb';

/**
 * One change to a document, as the bytes Yjs produced. The service never looks into
 * them; what it keeps is who changed something and when.
 */
export interface VersionRecord {
  _id: ObjectId;
  documentId: ObjectId;
  /** The document version these bytes build on. */
  baseVersion: number;
  update: Binary;
  actorId: string;
  createdAt: Date;
}

export interface NewVersion {
  readonly documentId: ObjectId;
  readonly baseVersion: number;
  readonly update: Uint8Array;
  readonly actorId: string;
}

export async function appendVersion(
  db: Db,
  input: NewVersion,
  now = new Date(),
): Promise<VersionRecord> {
  const record: VersionRecord = {
    _id: new ObjectId(),
    documentId: input.documentId,
    baseVersion: input.baseVersion,
    update: new Binary(input.update),
    actorId: input.actorId,
    createdAt: now,
  };

  await db.collection<VersionRecord>('versions').insertOne(record);
  return record;
}

/**
 * Every change on top of a base, in the order it arrived. For the resulting state the
 * order does not matter, Yjs converges either way; it matters for reading the history.
 */
export async function readVersions(
  db: Db,
  documentId: ObjectId,
  baseVersion: number,
): Promise<VersionRecord[]> {
  return db
    .collection<VersionRecord>('versions')
    .find({ documentId, baseVersion })
    .sort({ _id: 1 })
    .toArray();
}
