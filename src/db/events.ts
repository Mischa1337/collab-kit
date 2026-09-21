import { ObjectId, type Db, type Document, type Filter } from 'mongodb';

import { anchoredAt, type Anchor, type AnchorQuery } from './anchor.ts';

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

export async function recordEvent(db: Db, input: NewEvent, now = new Date()): Promise<EventRecord> {
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

  await db.collection<EventRecord>('events').insertOne(record);
  return record;
}

export interface EventQuery {
  readonly anchor?: AnchorQuery;
  readonly actorId?: string;
  readonly kind?: string;
  readonly limit?: number;
}

function filterOf(query: EventQuery): Filter<EventRecord> {
  return {
    ...(query.anchor === undefined ? {} : anchoredAt(query.anchor)),
    ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
    ...(query.kind === undefined ? {} : { kind: query.kind }),
  } as Filter<EventRecord>;
}

/** Newest first, because a history is read backwards from now. */
export async function readEvents(db: Db, query: EventQuery = {}): Promise<EventRecord[]> {
  const found = db.collection<EventRecord>('events').find(filterOf(query)).sort({ _id: -1 });

  return query.limit === undefined ? found.toArray() : found.limit(query.limit).toArray();
}

/**
 * The newest one alone. This is what a reading mark and a presence status are: not a
 * stored state but the last event of its kind.
 */
export async function latestEvent(db: Db, query: EventQuery): Promise<EventRecord | null> {
  return db.collection<EventRecord>('events').findOne(filterOf(query), { sort: { _id: -1 } });
}
