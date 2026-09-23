import { ObjectId, type ClientSession, type Db, type Document, type Filter } from 'mongodb';

import { anchoredAt, type Anchor, type AnchorQuery } from '../../anchor.ts';

/**
 * Something happened, by somebody, at a place, at a time. No content and no
 * responsibility: a comment is what a person says, an event only that something was.
 *
 * The kind is a free string. read, presence and visit are written by the service,
 * checkpoint by a person, and a tool may report whatever else it finds worth keeping.
 *
 * Append only. A reading mark is not a field that gets overwritten but the newest
 * event of kind read, which is why the reading history falls out for free.
 */
export interface EventRecord {
  _id: ObjectId;
  kind: string;
  actorId: string;
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

export interface NewEvent {
  readonly kind: string;
  readonly actorId: string;
  readonly anchor: Anchor;
  readonly at?: ObjectId;
  readonly label?: string;
  readonly reason?: string;
  readonly detail?: Document;
}

/**
 * The session is for callers that change something and keep the trace of it in the
 * same breath, so the two cannot come apart.
 */
export async function recordEvent(
  db: Db,
  input: NewEvent,
  now = new Date(),
  session?: ClientSession,
): Promise<EventRecord> {
  const record: EventRecord = {
    _id: new ObjectId(),
    kind: input.kind,
    actorId: input.actorId,
    anchor: input.anchor,
    createdAt: now,
    ...(input.at === undefined ? {} : { at: input.at }),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };

  await db
    .collection<EventRecord>('events')
    .insertOne(record, session === undefined ? {} : { session });

  return record;
}

export interface EventQuery {
  readonly anchor?: AnchorQuery;
  /** Anchors on any of these things, which is how a room asks about what it bundles. */
  readonly anchorIds?: readonly unknown[];
  readonly actorId?: string;
  readonly kind?: string;
  /** Only what happened after this event, the cut for polling. */
  readonly since?: ObjectId;
  readonly limit?: number;
}

function filterOf(query: EventQuery): Filter<EventRecord> {
  return {
    ...(query.anchor === undefined ? {} : anchoredAt(query.anchor)),
    ...(query.anchorIds === undefined ? {} : { 'anchor.id': { $in: [...query.anchorIds] } }),
    ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    ...(query.since === undefined ? {} : { _id: { $gt: query.since } }),
  } as Filter<EventRecord>;
}

/** Newest first, because a history is read backwards from now. */
export async function readEvents(db: Db, query: EventQuery = {}): Promise<EventRecord[]> {
  const found = db.collection<EventRecord>('events').find(filterOf(query)).sort({ _id: -1 });

  return query.limit === undefined ? found.toArray() : found.limit(query.limit).toArray();
}

/**
 * The same read forwards, oldest first, which is what asking again with `since`
 * needs: apply in order, keep the last _id, ask again with it. Same shape as
 * readUpdatesSince, and the reason the service needs no channel of its own to tell a
 * tool what happened.
 */
export async function readEventsSince(db: Db, query: EventQuery = {}): Promise<EventRecord[]> {
  const found = db.collection<EventRecord>('events').find(filterOf(query)).sort({ _id: 1 });

  return query.limit === undefined ? found.toArray() : found.limit(query.limit).toArray();
}

/**
 * The newest one alone. This is what a reading mark and a presence status are: not a
 * stored state but the last event of its kind.
 */
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

/**
 * Changes one row and keeps the trace of it in the same transaction. Both belong
 * together: the field alone would lose who declared it, and the trace alone would
 * claim a change that never happened.
 *
 * Returns the row as it now stands, without reading it back.
 */
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
