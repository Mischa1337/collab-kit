import type { Db, ObjectId } from 'mongodb';

import type { Reference } from '../model/anchor.ts';
import { findComment } from './collections/comments.ts';
import type { About } from './collections/events.ts';
import { findTask } from './collections/tasks.ts';

/** The thing a chain of comments and tasks ends at; none for a task that hangs on nothing. */
export async function aboutOf(db: Db, reference: Reference): Promise<About | undefined> {
  if (reference.kind === 'comment') {
    const comment = await findComment(db, reference.id);
    return comment === null ? undefined : aboutOf(db, comment.anchor);
  }
  if (reference.kind === 'task') {
    const task = await findTask(db, reference.id);
    return task === null ? undefined : aboutOfTask(db, task);
  }
  // A room, a workpiece or a group, without the unit: the room asks for the whole thing.
  return { kind: reference.kind, id: reference.id };
}

/** Through the anchor of a task, else through its parent; also for one not stored yet. */
export async function aboutOfTask(
  db: Db,
  task: { readonly anchor?: Reference | undefined; readonly parentId?: ObjectId | undefined },
): Promise<About | undefined> {
  // Anchors and parents only point at older entries, so the chain always ends.
  if (task.anchor !== undefined) {
    return aboutOf(db, task.anchor);
  }
  return task.parentId === undefined ? undefined : aboutOf(db, { kind: 'task', id: task.parentId });
}
