import { Binary, ObjectId, type Db, type Document } from 'mongodb';

/**
 * One row is a document at one version, carrying the full state. The newest row
 * of a documentId is marked with isCurrent.
 */
export interface DocumentVersion {
  _id: ObjectId;
  /** Stays the same across all versions, this is the identity of the document. */
  documentId: ObjectId;
  version: number;
  isCurrent: boolean;
  roomId: ObjectId;
  name: string;
  /** What the tool registered while docking. The service never reads into it. */
  contract: Document;
  /** Full Yjs state, opaque bytes to the service. */
  state: Binary;
  /** Only set when a person named this version. */
  label?: string;
  /** The why behind the version, which no protocol can derive. */
  reason?: string;
  actorId: string;
  createdAt: Date;
}

export interface NewDocument {
  readonly roomId: ObjectId;
  readonly name: string;
  readonly actorId: string;
  /** The starting state, produced by the caller, not by the storage layer. */
  readonly state: Uint8Array;
  readonly contract?: Document;
}

/** Creates version 1 of a document and marks it as the current one. */
export async function createDocument(db: Db, input: NewDocument): Promise<DocumentVersion> {
  const created: DocumentVersion = {
    _id: new ObjectId(),
    documentId: new ObjectId(),
    version: 1,
    isCurrent: true,
    roomId: input.roomId,
    name: input.name,
    contract: input.contract ?? {},
    state: new Binary(input.state),
    actorId: input.actorId,
    createdAt: new Date(),
  };

  await db.collection<DocumentVersion>('documents').insertOne(created);
  return created;
}

export interface NewDocumentVersion {
  readonly documentId: ObjectId;
  /** The complete state at this moment, produced by the caller. */
  readonly state: Uint8Array;
  readonly actorId: string;
  /** Set when a person named this version. An automatic one carries neither. */
  readonly label?: string;
  /** The why behind it, the one thing no protocol can derive. */
  readonly reason?: string;
}

/**
 * Writes the current state as the next version and moves isCurrent to it. Both writes
 * belong together: half of it would leave the document either without a valid row or
 * with two, which the unique partial index would refuse anyway.
 *
 * Nothing is deleted. The previous row and every change on it stay, which is what
 * makes looking back possible.
 */
export async function createVersion(
  db: Db,
  input: NewDocumentVersion,
  now = new Date(),
): Promise<DocumentVersion> {
  const documents = db.collection<DocumentVersion>('documents');
  const session = db.client.startSession();

  try {
    return await session.withTransaction(async () => {
      const current = await documents.findOne(
        { documentId: input.documentId, isCurrent: true },
        { session },
      );

      if (current === null) {
        throw new Error(`no current version for document ${input.documentId.toHexString()}`);
      }

      const created: DocumentVersion = {
        _id: new ObjectId(),
        documentId: input.documentId,
        version: current.version + 1,
        isCurrent: true,
        roomId: current.roomId,
        name: current.name,
        contract: current.contract,
        state: new Binary(input.state),
        actorId: input.actorId,
        createdAt: now,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      };

      // The old row loses isCurrent first: the other way round the unique index would
      // see two valid rows and refuse the insert.
      await documents.updateOne({ _id: current._id }, { $set: { isCurrent: false } }, { session });
      await documents.insertOne(created, { session });

      return created;
    });
  } finally {
    await session.endSession();
  }
}
