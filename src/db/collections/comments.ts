import { ObjectId, type Db, type Document, type Filter } from 'mongodb';

import { anchorSchema, anchoredAt, type Anchor, type AnchorQuery } from '../../model/anchor.ts';
import { defined, matchOptional } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';
import { changeWithEvent } from './events.ts';

/**
 * Something a person said, at a place, possibly in answer to something else. Comment,
 * feedback, chat message, annotation and reaction are this one form with a different
 * kind and a different anchor.
 *
 * Unlike a task this always has an anchor: saying something about nothing is not a
 * thing. Without a unit it is about the whole, with one about a single place, and
 * that difference is all there is to local versus global feedback, D8.19.
 */
export interface CommentRecord {
  _id: ObjectId;
  kind: string;
  anchor: Anchor;
  /** Makes it an answer to another comment, D4.13. */
  parentId?: ObjectId;
  createdBy: string;
  /** Free, the service never reads it. What a contribution is made of is not its business. */
  body: Document;
  /** Free, D8.20: open, read, answered, applied, rejected, whatever the tool names. */
  state?: string;
  createdAt: Date;
}

export const commentsDefinition: CollectionDefinition = {
  name: 'comments',
  schema: {
    bsonType: 'object',
    required: ['kind', 'anchor', 'createdBy', 'body', 'createdAt'],
    properties: {
      kind: { bsonType: 'string', description: 'comment, feedback, message, reaction, ...' },
      anchor: anchorSchema,
      parentId: { bsonType: 'objectId', description: 'makes it an answer, D4.13' },
      createdBy: { bsonType: 'string' },
      body: { bsonType: 'object', description: 'free, the service never reads it' },
      state: {
        bsonType: 'string',
        description: 'free, D8.20: open, read, answered, applied, rejected',
      },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [
    { key: { 'anchor.id': 1, _id: 1 }, name: 'anchor_id' },
    { key: { parentId: 1, _id: 1 }, name: 'parent_thread' },
    { key: { createdBy: 1, _id: 1 }, name: 'created_by' },
  ],
};

export interface NewComment {
  readonly kind: string;
  readonly anchor: Anchor;
  readonly createdBy: string;
  readonly body: Document;
  readonly parentId?: ObjectId;
  readonly state?: string;
}

export async function createComment(
  db: Db,
  input: NewComment,
  now = new Date(),
): Promise<CommentRecord> {
  const comment: CommentRecord = {
    _id: new ObjectId(),
    kind: input.kind,
    anchor: input.anchor,
    createdBy: input.createdBy,
    body: input.body,
    createdAt: now,
    ...defined({ parentId: input.parentId, state: input.state }),
  };

  await db.collection<CommentRecord>('comments').insertOne(comment);
  return comment;
}

export async function findComment(db: Db, id: ObjectId): Promise<CommentRecord | null> {
  return db.collection<CommentRecord>('comments').findOne({ _id: id });
}

export interface CommentStateChange {
  readonly state: string;
  readonly changedBy: string;
  readonly reason?: string;
}

/**
 * Moves the state and keeps who moved it, in one transaction. Who marked a piece of
 * feedback as applied is the part of D8.16 that a field alone would throw away.
 */
export async function setCommentState(
  db: Db,
  commentId: ObjectId,
  input: CommentStateChange,
  now = new Date(),
): Promise<CommentRecord> {
  return changeWithEvent<CommentRecord>(
    db,
    {
      what: 'comment',
      collection: 'comments',
      id: commentId,
      change: { state: input.state },
      event: {
        kind: 'comment-state',
        createdBy: input.changedBy,
        anchor: { kind: 'comment', id: commentId },
        detail: { to: input.state },
        ...defined({ reason: input.reason }),
      },
    },
    now,
  );
}

/** Matches comments that answer nothing, so the starts of the threads can be asked for. */
export const ROOT = null;

export interface CommentQuery {
  readonly kind?: string;
  readonly state?: string;
  readonly createdBy?: string;
  readonly anchor?: AnchorQuery;
  /** Left out matches every comment, ROOT only those that answer nothing. */
  readonly parentId?: ObjectId | null;
}

/**
 * Oldest first, unlike the events: a conversation is read forwards, a history
 * backwards.
 */
export async function readComments(db: Db, query: CommentQuery = {}): Promise<CommentRecord[]> {
  const filter: Document = {
    ...(query.anchor === undefined ? {} : anchoredAt(query.anchor)),
    ...defined({ kind: query.kind, state: query.state, createdBy: query.createdBy }),
    ...matchOptional('parentId', query.parentId),
  };

  return db
    .collection<CommentRecord>('comments')
    .find(filter as Filter<CommentRecord>)
    .sort({ _id: 1 })
    .toArray();
}
