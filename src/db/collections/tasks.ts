import { ObjectId, type Db, type Document, type Filter } from 'mongodb';

import { anchorSchema, anchoredAt, type Anchor, type AnchorQuery } from '../../model/anchor.ts';
import { defined, matchOptional } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';
import { changeWithEvent } from './events.ts';

/** Who a task is assigned to. A group can hold one, the change it leads to cannot. */
export interface Assignee {
  kind: 'actor' | 'group';
  id: unknown;
}

/** Something to be done, with a state; its history lives in events, state is only the shortcut. */
export interface TaskRecord {
  _id: ObjectId;
  kind: string;
  title: string;
  state: string;
  /** What it is about. With a unit it is the cut of a subtask. */
  anchor?: Anchor;
  parentId?: ObjectId;
  assignee?: Assignee;
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
      assignee: {
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
    { key: { 'assignee.id': 1, state: 1 }, name: 'assignee_state' },
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
  readonly assignee?: Assignee;
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
      assignee: input.assignee,
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
  change: Partial<Pick<TaskRecord, 'state' | 'assignee'>>,
  event: { kind: string; createdBy: string; reason?: string; detail: Document },
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
        createdBy: event.createdBy,
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
  readonly changedBy: string;
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
      createdBy: input.changedBy,
      detail: { to: input.state },
      ...defined({ reason: input.reason }),
    },
    now,
  );
}

export interface Assignment {
  readonly assignee: Assignee;
  readonly changedBy: string;
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
    { assignee: input.assignee },
    {
      kind: 'task-assignee',
      createdBy: input.changedBy,
      detail: { to: input.assignee },
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
  readonly assignee?: Assignee;
  readonly anchor?: AnchorQuery;
  /** Left out matches every task, TOP only those without a parent. */
  readonly parentId?: ObjectId | null;
}

/** Sorted by order, then by _id: a sequence in its order, the rest as it was created. */
export async function readTasks(db: Db, query: TaskQuery = {}): Promise<TaskRecord[]> {
  const filter: Document = {
    ...(query.anchor === undefined ? {} : anchoredAt(query.anchor)),
    ...defined({ kind: query.kind, state: query.state }),
    ...(query.assignee === undefined
      ? {}
      : { 'assignee.kind': query.assignee.kind, 'assignee.id': query.assignee.id }),
    ...matchOptional('parentId', query.parentId),
  };

  return db
    .collection<TaskRecord>('tasks')
    .find(filter as Filter<TaskRecord>)
    .sort({ order: 1, _id: 1 })
    .toArray();
}
