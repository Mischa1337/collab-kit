import { ObjectId, type Db, type Document, type Filter } from 'mongodb';

import { anchorSchema, anchoredAt, type Anchor, type AnchorQuery } from '../../model/anchor.ts';
import { defined, matchOptional } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';
import { changeWithEvent, writeWithEvents, type About, type NewEvent } from './events.ts';

/** Who a task is assigned to: a person by actor key, or a group; a change cannot hold one. */
export type Assignee = { kind: 'actor'; id: string } | { kind: 'group'; id: ObjectId };

/** Something to be done, with a state; its history lives in events, state is only the shortcut. */
export interface TaskRecord {
  _id: ObjectId;
  kind: string;
  title: string;
  state: string;
  /** What it is about. With a unit it is the cut of a subtask. */
  anchor?: Anchor;
  parentId?: ObjectId;
  /** Persons and groups side by side; who gave or took them, and when, is in events. */
  assignees: Assignee[];
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
    required: ['kind', 'title', 'state', 'assignees', 'createdAt', 'createdBy'],
    properties: {
      kind: { bsonType: 'string', description: 'task, review, revision, approval, ...' },
      title: { bsonType: 'string' },
      state: {
        bsonType: 'string',
        description: 'free, the docking tool brings its own vocabulary',
      },
      anchor: anchorSchema,
      parentId: { bsonType: 'objectId', description: 'makes it a subtask' },
      assignees: {
        bsonType: 'array',
        description: 'persons and groups side by side, empty when nobody has it yet',
        items: {
          bsonType: 'object',
          required: ['kind', 'id'],
          oneOf: [
            { properties: { kind: { enum: ['actor'] }, id: { bsonType: 'string' } } },
            { properties: { kind: { enum: ['group'] }, id: { bsonType: 'objectId' } } },
          ],
        },
      },
      order: { bsonType: 'number', description: 'order among siblings, D9.3' },
      detail: { bsonType: 'object', description: 'free, the service never reads it' },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [
    { key: { 'assignees.id': 1, state: 1 }, name: 'assignees_state' },
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
  /** Given all at the moment it is created; each one counts once. */
  readonly assignees?: readonly Assignee[];
  readonly order?: number;
  readonly detail?: Document;
  /** What its anchor or parent hangs on in the end, for the trace; the route looks it up. */
  readonly about?: About;
}

/** Stores the task and records task-created in one transaction, its content not in it. */
export async function createTask(db: Db, input: NewTask, now = new Date()): Promise<TaskRecord> {
  const task: TaskRecord = {
    _id: new ObjectId(),
    kind: input.kind,
    title: input.title,
    state: input.state,
    assignees: distinct(input.assignees ?? []),
    createdAt: now,
    createdBy: input.createdBy,
    ...defined({
      anchor: input.anchor,
      parentId: input.parentId,
      order: input.order,
      detail: input.detail,
    }),
  };

  await writeWithEvents(
    db,
    async (session) => {
      await db.collection<TaskRecord>('tasks').insertOne(task, { session });
      return true;
    },
    [
      {
        kind: 'task-created',
        createdBy: input.createdBy,
        anchor: { kind: 'task', id: task._id },
        ...defined({ about: input.about }),
      },
    ],
    now,
  );
  return task;
}

export async function findTask(db: Db, id: ObjectId): Promise<TaskRecord | null> {
  return db.collection<TaskRecord>('tasks').findOne({ _id: id });
}

/** Field and trace, or neither. */
async function changeTask(
  db: Db,
  taskId: ObjectId,
  change: Partial<Pick<TaskRecord, 'state'>>,
  event: { kind: string; createdBy: string; reason?: string; about?: About; detail: Document },
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
        ...defined({ about: event.about, reason: event.reason }),
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
  readonly about?: About;
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
      ...defined({ about: input.about, reason: input.reason }),
    },
    now,
  );
}

export interface Assignment {
  readonly assignee: Assignee;
  readonly changedBy: string;
  /** Why it was given or taken, D6.6. */
  readonly reason?: string;
  readonly about?: About;
}

/** Gives the task to one more person or group if new and records it; answers whether it was new. */
export async function addAssignee(
  db: Db,
  taskId: ObjectId,
  input: Assignment,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<TaskRecord>('tasks')
        .updateOne(
          { _id: taskId, assignees: { $not: { $elemMatch: input.assignee } } },
          { $push: { assignees: input.assignee } },
          { session },
        );

      return result.modifiedCount === 1;
    },
    [assigneeEvent('assignee-added', taskId, input)],
    now,
  );
}

/** Takes one person or group off the task and records it; answers whether it was there. */
export async function removeAssignee(
  db: Db,
  taskId: ObjectId,
  input: Assignment,
  now = new Date(),
): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<TaskRecord>('tasks')
        .updateOne({ _id: taskId }, { $pull: { assignees: input.assignee } }, { session });

      return result.modifiedCount === 1;
    },
    [assigneeEvent('assignee-removed', taskId, input)],
    now,
  );
}

/** Matches tasks that have no parent, so the top of a tree can be asked for. */
export const TOP = null;

export interface TaskQuery {
  readonly kind?: string;
  readonly state?: string;
  /** Assigned to any of these; a person and their groups is how "mine" is asked for. */
  readonly assignees?: readonly [Assignee, ...Assignee[]];
  readonly anchor?: AnchorQuery;
  /** Left out matches every task, TOP only those without a parent. */
  readonly parentId?: ObjectId | null;
}

/** Sorted by order, then by _id: a sequence in its order, the rest as it was created. */
export async function readTasks(db: Db, query: TaskQuery = {}): Promise<TaskRecord[]> {
  const filter: Document = {
    ...(query.anchor === undefined ? {} : anchoredAt(query.anchor)),
    ...defined({ kind: query.kind, state: query.state }),
    // $elemMatch, so kind and id come from the same entry and not from two different ones.
    ...(query.assignees === undefined
      ? {}
      : {
          $or: query.assignees.map((assignee) => ({
            assignees: { $elemMatch: { kind: assignee.kind, id: assignee.id } },
          })),
        }),
    ...matchOptional('parentId', query.parentId),
  };

  return db
    .collection<TaskRecord>('tasks')
    .find(filter as Filter<TaskRecord>)
    .sort({ order: 1, _id: 1 })
    .toArray();
}

/** Each assignee once, the first place kept; kind and id together make one. */
function distinct(assignees: readonly Assignee[]): Assignee[] {
  const seen = new Map(assignees.map((entry) => [`${entry.kind}:${String(entry.id)}`, entry]));
  return [...seen.values()];
}

/** The trace of a change to who has the task, anchored at the task. */
function assigneeEvent(kind: string, taskId: ObjectId, input: Assignment): NewEvent {
  return {
    kind,
    createdBy: input.changedBy,
    anchor: { kind: 'task', id: taskId },
    detail: { ...input.assignee },
    ...defined({ about: input.about, reason: input.reason }),
  };
}
