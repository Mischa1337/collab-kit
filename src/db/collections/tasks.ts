import { ObjectId, type Db, type Document, type Filter } from 'mongodb';

import { anchorSchema, anchoredAt, type Anchor, type AnchorQuery } from '../../anchor.ts';
import { defined, matchOptional } from '../../optional.ts';
import type { CollectionDefinition } from '../apply.ts';
import { changeWithEvent } from './events.ts';

/** Who a task belongs to. A group can hold one, the change it leads to cannot. */
export interface TaskSubject {
  kind: 'actor' | 'group';
  id: unknown;
}

/**
 * Something that should be done, by somebody, with a state. Task, subtask, review
 * order, revision and approval are this one form with a different kind.
 *
 * `state` is the current value and therefore queryable; how it got there lives in
 * `events`. That is the same relation as `documents.state` to `updates`: the field is
 * the shortcut, the stream is the truth.
 */
export interface TaskRecord {
  _id: ObjectId;
  kind: string;
  title: string;
  state: string;
  /** What it is about. With a unit it is the cut of a subtask. */
  anchor?: Anchor;
  parentId?: ObjectId;
  subject?: TaskSubject;
  /** Order among siblings, D9.3. The tool decides the numbers. */
  order?: number;
  /** Free, the service never reads it. */
  detail?: Document;
  createdAt: Date;
  createdBy: string;
}

export const tasksDefinition: CollectionDefinition = {
  name: 'tasks',
  schema: {
    bsonType: 'object',
    required: ['kind', 'title', 'state', 'createdAt', 'createdBy'],
    properties: {
      kind: { bsonType: 'string', description: 'task, review, revision, approval, ...' },
      title: { bsonType: 'string' },
      state: {
        bsonType: 'string',
        description: 'free, the docking tool brings its own vocabulary',
      },
      anchor: anchorSchema,
      parentId: { bsonType: 'objectId', description: 'makes it a subtask' },
      subject: {
        bsonType: 'object',
        required: ['kind', 'id'],
        properties: { kind: { enum: ['actor', 'group'] }, id: {} },
      },
      order: { bsonType: 'number', description: 'order among siblings, D9.3' },
      detail: { bsonType: 'object', description: 'free, the service never reads it' },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [
    { key: { 'subject.id': 1, state: 1 }, name: 'subject_state' },
    { key: { 'anchor.id': 1 }, name: 'anchor_id' },
    { key: { parentId: 1, order: 1 }, name: 'parent_order' },
  ],
};

export interface NewTask {
  readonly kind: string;
  readonly title: string;
  /** No default: naming the first state is the business of the tool. */
  readonly state: string;
  readonly createdBy: string;
  readonly anchor?: Anchor;
  readonly parentId?: ObjectId;
  readonly subject?: TaskSubject;
  readonly order?: number;
  readonly detail?: Document;
}

export async function createTask(db: Db, input: NewTask, now = new Date()): Promise<TaskRecord> {
  const task: TaskRecord = {
    _id: new ObjectId(),
    kind: input.kind,
    title: input.title,
    state: input.state,
    createdAt: now,
    createdBy: input.createdBy,
    ...defined({
      anchor: input.anchor,
      parentId: input.parentId,
      subject: input.subject,
      order: input.order,
      detail: input.detail,
    }),
  };

  await db.collection<TaskRecord>('tasks').insertOne(task);
  return task;
}

export async function findTask(db: Db, id: ObjectId): Promise<TaskRecord | null> {
  return db.collection<TaskRecord>('tasks').findOne({ _id: id });
}

/** Both changing operations go the same way: field and trace, or neither. */
async function changeTask(
  db: Db,
  taskId: ObjectId,
  change: Partial<Pick<TaskRecord, 'state' | 'subject'>>,
  event: { kind: string; actorId: string; reason?: string; detail: Document },
  now: Date,
): Promise<TaskRecord> {
  return changeWithEvent<TaskRecord>(
    db,
    {
      what: 'task',
      collection: 'tasks',
      id: taskId,
      change,
      event: {
        kind: event.kind,
        actorId: event.actorId,
        anchor: { kind: 'task', id: taskId },
        detail: event.detail,
        ...defined({ reason: event.reason }),
      },
    },
    now,
  );
}

export interface StateChange {
  readonly state: string;
  readonly actorId: string;
  /** Why it moved. The same why as at a checkpoint, D6.6. */
  readonly reason?: string;
}

export async function setTaskState(
  db: Db,
  taskId: ObjectId,
  input: StateChange,
  now = new Date(),
): Promise<TaskRecord> {
  return changeTask(
    db,
    taskId,
    { state: input.state },
    {
      kind: 'task-state',
      actorId: input.actorId,
      detail: { to: input.state },
      ...defined({ reason: input.reason }),
    },
    now,
  );
}

export interface Assignment {
  readonly subject: TaskSubject;
  readonly actorId: string;
  readonly reason?: string;
}

export async function assignTask(
  db: Db,
  taskId: ObjectId,
  input: Assignment,
  now = new Date(),
): Promise<TaskRecord> {
  return changeTask(
    db,
    taskId,
    { subject: input.subject },
    {
      kind: 'task-subject',
      actorId: input.actorId,
      detail: { to: input.subject },
      ...defined({ reason: input.reason }),
    },
    now,
  );
}

/** Matches tasks that have no parent, so the top of a tree can be asked for. */
export const TOP = null;

export interface TaskQuery {
  readonly kind?: string;
  readonly state?: string;
  readonly subject?: { readonly kind: string; readonly id: unknown };
  readonly anchor?: AnchorQuery;
  /** Left out matches every task, TOP only those without a parent. */
  readonly parentId?: ObjectId | null;
}

/**
 * Sorted by order and then by _id, so a sequence comes back in its sequence and
 * everything without one stays in the order it was created.
 */
export async function readTasks(db: Db, query: TaskQuery = {}): Promise<TaskRecord[]> {
  const filter: Document = {
    ...(query.anchor === undefined ? {} : anchoredAt(query.anchor)),
    ...defined({ kind: query.kind, state: query.state }),
    ...(query.subject === undefined
      ? {}
      : { 'subject.kind': query.subject.kind, 'subject.id': query.subject.id }),
    ...matchOptional('parentId', query.parentId),
  };

  return db
    .collection<TaskRecord>('tasks')
    .find(filter as Filter<TaskRecord>)
    .sort({ order: 1, _id: 1 })
    .toArray();
}
