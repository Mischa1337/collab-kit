import { ObjectId, type Db, type Document, type Filter } from 'mongodb';

import { anchorSchema, anchoredAt, type Anchor, type AnchorQuery } from '../../model/anchor.ts';
import { defined, matchOptional } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';
import { changeWithEvent, writeWithEvents, type NewEvent } from './events.ts';

/** Something a person said about a place; feedback, chat and reactions differ only in kind. */
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
  /** When the words last changed, a shortcut; the old words are kept nowhere. */
  editedAt?: Date;
  /** Set once the words are gone; the shell stays so the answers keep their thread. */
  deletedAt?: Date;
  deletedBy?: string;
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
      editedAt: { bsonType: 'date', description: 'when the words last changed' },
      deletedAt: { bsonType: 'date', description: 'the words are gone, the shell stays' },
      deletedBy: { bsonType: 'string' },
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

/** Moves the state and records who moved it, D8.16, in one transaction. */
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

export interface CommentBodyChange {
  readonly body: Document;
  readonly changedBy: string;
  readonly reason?: string;
}

/** Replaces the words and records who did, never what stood there; answers whether they changed. */
export async function setCommentBody(
  db: Db,
  commentId: ObjectId,
  input: CommentBodyChange,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      // Only a live comment, and only if the words differ, so the same words leave no trace.
      const result = await db
        .collection<CommentRecord>('comments')
        .updateOne(
          { _id: commentId, deletedAt: { $exists: false }, body: { $ne: input.body } },
          { $set: { body: input.body, editedAt: now } },
          { session },
        );
      return result.modifiedCount === 1;
    },
    [commentEvent('comment-edited', commentId, input.changedBy, input.reason)],
    now,
  );
}

export interface CommentDeletion {
  readonly deletedBy: string;
  readonly reason?: string;
}

/** Takes the words away for good and leaves the shell; answers whether it was still there. */
export async function deleteComment(
  db: Db,
  commentId: ObjectId,
  input: CommentDeletion,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<CommentRecord>('comments')
        .updateOne(
          { _id: commentId, deletedAt: { $exists: false } },
          { $set: { body: {}, deletedAt: now, deletedBy: input.deletedBy } },
          { session },
        );
      return result.modifiedCount === 1;
    },
    [commentEvent('comment-deleted', commentId, input.deletedBy, input.reason)],
    now,
  );
}

/** The trace of a change to the words, at the comment, without the words themselves. */
function commentEvent(kind: string, commentId: ObjectId, by: string, reason?: string): NewEvent {
  return {
    kind,
    createdBy: by,
    anchor: { kind: 'comment', id: commentId },
    ...defined({ reason }),
  };
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
  /** Only what was said after this comment, the cut for polling. */
  readonly since?: ObjectId;
}

/** Oldest first, unlike the events: a conversation is read forwards. */
export async function readComments(db: Db, query: CommentQuery = {}): Promise<CommentRecord[]> {
  const filter: Document = {
    ...(query.anchor === undefined ? {} : anchoredAt(query.anchor)),
    ...defined({ kind: query.kind, state: query.state, createdBy: query.createdBy }),
    ...matchOptional('parentId', query.parentId),
    ...(query.since === undefined ? {} : { _id: { $gt: query.since } }),
  };

  return db
    .collection<CommentRecord>('comments')
    .find(filter as Filter<CommentRecord>)
    .sort({ _id: 1 })
    .toArray();
}
