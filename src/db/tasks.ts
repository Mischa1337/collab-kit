import { ObjectId, type Db, type Document, type Filter } from 'mongodb';

import { anchoredAt, type Anchor, type AnchorQuery } from './anchor.ts';
import { recordEvent } from './events.ts';

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
    ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.order === undefined ? {} : { order: input.order }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };

  await db.collection<TaskRecord>('tasks').insertOne(task);
  return task;
}

export async function findTask(db: Db, id: ObjectId): Promise<TaskRecord | null> {
  return db.collection<TaskRecord>('tasks').findOne({ _id: id });
}

/**
 * Changes one field of a task and keeps the trace of it in the same transaction. Both
 * belong together: the field alone would lose who declared it, which is what D8.21
 * asks for, and the trace alone would claim a change that never happened.
 */
async function changeTask(
  db: Db,
  taskId: ObjectId,
  change: Partial<Pick<TaskRecord, 'state' | 'subject'>>,
  event: { kind: string; actorId: string; reason?: string; detail: Document },
  now: Date,
): Promise<TaskRecord> {
  const session = db.client.startSession();

  try {
    return await session.withTransaction(async () => {
      const tasks = db.collection<TaskRecord>('tasks');
      const before = await tasks.findOne({ _id: taskId }, { session });

      if (before === null) {
        throw new Error(`unknown task ${taskId.toHexString()}`);
      }

      await tasks.updateOne({ _id: taskId }, { $set: change }, { session });
      await recordEvent(
        db,
        {
          kind: event.kind,
          actorId: event.actorId,
          anchor: { kind: 'task', id: taskId },
          detail: event.detail,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        },
        now,
        session,
      );

      return { ...before, ...change };
    });
  } finally {
    await session.endSession();
  }
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
      ...(input.reason === undefined ? {} : { reason: input.reason }),
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
      ...(input.reason === undefined ? {} : { reason: input.reason }),
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
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    ...(query.state === undefined ? {} : { state: query.state }),
    ...(query.subject === undefined
      ? {}
      : { 'subject.kind': query.subject.kind, 'subject.id': query.subject.id }),
  };

  if (query.parentId === TOP) {
    filter['parentId'] = { $exists: false };
  } else if (query.parentId !== undefined) {
    filter['parentId'] = query.parentId;
  }

  return db
    .collection<TaskRecord>('tasks')
    .find(filter as Filter<TaskRecord>)
    .sort({ order: 1, _id: 1 })
    .toArray();
}
