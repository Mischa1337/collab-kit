import { ObjectId, type ClientSession, type Db, type Document, type Filter } from 'mongodb';

import {
  anchorSchema,
  anchoredAt,
  type Anchor,
  type AnchorQuery,
  type Reference,
} from '../../model/anchor.ts';
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

/** Kinds only the service writes, each the proof of a change it made; add every new one here. */
export const SERVICE_KINDS: ReadonlySet<string> = new Set([
  'joined',
  'left',
  'checkpoint',
  'member-added',
  'member-removed',
  'reference-added',
  'reference-removed',
  'task-state',
  'assignee-added',
  'assignee-removed',
  'comment-state',
  'grant-set',
  'grant-removed',
  'comment-edited',
  'comment-deleted',
  'room-renamed',
  'room-deleted',
  'group-renamed',
  'group-deleted',
]);

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
  const record = recordOf(input, now);

  await db.collection<EventRecord>('events').insertOne(record, defined({ session }));

  return record;
}

function recordOf(input: NewEvent, now: Date): EventRecord {
  return {
    _id: new ObjectId(),
    kind: input.kind,
    createdBy: input.createdBy,
    anchor: input.anchor,
    createdAt: now,
    ...defined({ at: input.at, label: input.label, reason: input.reason, detail: input.detail }),
  };
}

export interface EventQuery {
  readonly anchor?: AnchorQuery;
  /** Anchors on any of these things, by kind and id; how a room asks about what it bundles. */
  readonly references?: readonly [Reference, ...Reference[]];
  readonly createdBy?: string;
  readonly kind?: string;
  /** Only what happened after this event, the cut for polling. */
  readonly since?: ObjectId;
  /** Only what happened before this event, for paging back through a history. */
  readonly before?: ObjectId;
  readonly limit?: number;
}

function filterOf(query: EventQuery): Filter<EventRecord> {
  // Both cuts work on _id, so they have to share one condition.
  const window = defined({ $gt: query.since, $lt: query.before });

  return {
    ...(query.anchor === undefined ? {} : anchoredAt(query.anchor)),
    ...(query.references === undefined
      ? {}
      : { $or: query.references.map((reference) => anchoredAt(reference)) }),
    ...defined({ createdBy: query.createdBy, kind: query.kind }),
    ...(Object.keys(window).length === 0 ? {} : { _id: window }),
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

/** Changes one row, records its event only if it did change, returns the row as it now stands. */
export async function changeWithEvent<T extends Document>(
  db: Db,
  input: TracedChange,
  now = new Date(),
): Promise<T> {
  return inTransaction(db, async (session) => {
    const collection = db.collection(input.collection);
    const before = await collection.findOne({ _id: input.id }, { session });

    if (before === null) {
      throw new Error(`unknown ${input.what} ${input.id.toHexString()}`);
    }

    const result = await collection.updateOne(
      { _id: input.id },
      { $set: input.change },
      { session },
    );

    if (result.modifiedCount === 1) {
      await recordEvent(db, input.event, now, session);
    }

    return { ...before, ...input.change } as unknown as T;
  });
}

/** Runs the write and, only if it changed something, records the events, all in one transaction. */
export async function writeWithEvents(
  db: Db,
  write: (session: ClientSession) => Promise<boolean>,
  events: readonly NewEvent[],
  now = new Date(),
): Promise<boolean> {
  return inTransaction(db, async (session) => {
    if (!(await write(session))) {
      return false;
    }

    if (events.length > 0) {
      const records = events.map((event) => recordOf(event, now));
      await db.collection<EventRecord>('events').insertMany(records, { session });
    }

    return true;
  });
}

/** As writeWithEvents, for a write whose events depend on what it finds; none means no change. */
export async function writeReturningEvents(
  db: Db,
  write: (session: ClientSession) => Promise<readonly NewEvent[]>,
  now = new Date(),
): Promise<boolean> {
  return inTransaction(db, async (session) => {
    const events = await write(session);
    if (events.length === 0) {
      return false;
    }

    const records = events.map((event) => recordOf(event, now));
    await db.collection<EventRecord>('events').insertMany(records, { session });
    return true;
  });
}

/** Runs the work in one transaction and closes the session afterwards, even after an error. */
async function inTransaction<T>(db: Db, work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = db.client.startSession();

  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
}
