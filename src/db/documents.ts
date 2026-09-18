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
