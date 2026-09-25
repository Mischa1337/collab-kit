import { ObjectId, type ClientSession, type Db, type Document, type Filter } from 'mongodb';

import { anchorSchema, anchoredAt, type Anchor, type AnchorQuery } from '../../model/anchor.ts';
import { defined } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';

/** That something happened, by whom, where and when; append only, never changed afterwards. */
export interface EventRecord {
  _id: ObjectId;
  kind: string;
  createdBy: string;
  anchor: Anchor;
  /** A place in the update stream, for a reading mark or a checkpoint. */
  at?: ObjectId;
  /** Only set when a person named this moment. */
  label?: string;
  /** The why, D6.6, the one thing no protocol can derive. */
  reason?: string;
  /** Free, the service never reads it. */
  detail?: Document;
  createdAt: Date;
}

export const eventsDefinition: CollectionDefinition = {
  name: 'events',
  schema: {
    bsonType: 'object',
    required: ['kind', 'createdBy', 'anchor', 'createdAt'],
    properties: {
      kind: {
        bsonType: 'string',
        description: 'free, e.g. joined, left, checkpoint, task-state or whatever the tool reports',
      },
      createdBy: { bsonType: 'string' },
      anchor: anchorSchema,
      at: { bsonType: 'objectId', description: 'a place in the update stream' },
      label: { bsonType: 'string', description: 'only when a person named this moment' },
      reason: { bsonType: 'string', description: 'the why, D6.6, can only come from a person' },
      detail: { bsonType: 'object', description: 'free, the service never reads it' },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { 'anchor.id': 1, kind: 1, _id: -1 }, name: 'anchor_id_kind' }],
};

export interface NewEvent {
  readonly kind: string;
  readonly createdBy: string;
  readonly anchor: Anchor;
  readonly at?: ObjectId;
  readonly label?: string;
  readonly reason?: string;
  readonly detail?: Document;
}

/** With a session, the event lands in the same transaction as the change it traces. */
export async function recordEvent(
  db: Db,
  input: NewEvent,
  now = new Date(),
  session?: ClientSession,
): Promise<EventRecord> {
  const record: EventRecord = {
    _id: new ObjectId(),
    kind: input.kind,
    createdBy: input.createdBy,
    anchor: input.anchor,
    createdAt: now,
    ...defined({ at: input.at, label: input.label, reason: input.reason, detail: input.detail }),
  };

  await db.collection<EventRecord>('events').insertOne(record, defined({ session }));

  return record;
}

export interface EventQuery {
  readonly anchor?: AnchorQuery;
  /** Anchors on any of these things, which is how a room asks about what it bundles. */
  readonly anchorIds?: readonly unknown[];
  readonly createdBy?: string;
  readonly kind?: string;
  /** Only what happened after this event, the cut for polling. */
  readonly since?: ObjectId;
  readonly limit?: number;
}

function filterOf(query: EventQuery): Filter<EventRecord> {
  return {
    ...(query.anchor === undefined ? {} : anchoredAt(query.anchor)),
    ...(query.anchorIds === undefined ? {} : { 'anchor.id': { $in: [...query.anchorIds] } }),
    ...defined({ createdBy: query.createdBy, kind: query.kind }),
    ...(query.since === undefined ? {} : { _id: { $gt: query.since } }),
  } as Filter<EventRecord>;
}

/** Newest first, because a history is read backwards from now. */
export async function readEvents(db: Db, query: EventQuery = {}): Promise<EventRecord[]> {
  const found = db.collection<EventRecord>('events').find(filterOf(query)).sort({ _id: -1 });

  return query.limit === undefined ? found.toArray() : found.limit(query.limit).toArray();
}

/** Oldest first, for polling: keep the last _id and ask again with it as `since`. */
export async function readEventsSince(db: Db, query: EventQuery = {}): Promise<EventRecord[]> {
  const found = db.collection<EventRecord>('events').find(filterOf(query)).sort({ _id: 1 });

  return query.limit === undefined ? found.toArray() : found.limit(query.limit).toArray();
}

/** Only the newest; a reading mark is no stored field but the last event of kind read. */
export async function latestEvent(db: Db, query: EventQuery): Promise<EventRecord | null> {
  return db.collection<EventRecord>('events').findOne(filterOf(query), { sort: { _id: -1 } });
}

export interface TracedChange {
  /** The noun for the error when nothing is there, for example "task". */
  readonly what: string;
  readonly collection: string;
  readonly id: ObjectId;
  readonly change: Document;
  readonly event: NewEvent;
}

/** Changes one row and records its event in one transaction; returns the row without rereading. */
export async function changeWithEvent<T extends Document>(
  db: Db,
  input: TracedChange,
  now = new Date(),
): Promise<T> {
  const session = db.client.startSession();

  try {
    return await session.withTransaction(async () => {
      const collection = db.collection(input.collection);
      const before = await collection.findOne({ _id: input.id }, { session });

      if (before === null) {
        throw new Error(`unknown ${input.what} ${input.id.toHexString()}`);
      }

      await collection.updateOne({ _id: input.id }, { $set: input.change }, { session });
      await recordEvent(db, input.event, now, session);

      return { ...before, ...input.change } as unknown as T;
    });
  } finally {
    await session.endSession();
  }
}
