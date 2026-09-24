import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { readEvents } from '../../src/db/collections/events.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import {
  assignTask,
  createTask,
  findTask,
  readTasks,
  setTaskState,
  TOP,
  type TaskRecord,
} from '../../src/db/collections/tasks.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_tasks_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;

const plain = (over: Partial<Parameters<typeof createTask>[1]> = {}) =>
  createTask(storage.db, {
    kind: 'task',
    title: 'Kundenteil modellieren',
    state: 'offen',
    createdBy: 'alice',
    ...over,
  });

const historyOf = (task: TaskRecord) =>
  readEvents(storage.db, { anchor: { kind: 'task', id: task._id } });

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

describe('creating a task', () => {
  it('needs nothing but a kind, a title, a state and a creator', async () => {
    const created = await plain();

    expect(created).toMatchObject({
      kind: 'task',
      title: 'Kundenteil modellieren',
      state: 'offen',
    });
    expect(created.subject).toBeUndefined();
    expect(created.anchor).toBeUndefined();
    expect(created.parentId).toBeUndefined();
  });

  it('cuts out a part of a workpiece when it carries a unit', async () => {
    const workpieceId = new ObjectId();
    const created = await plain({
      anchor: { kind: 'workpiece', id: workpieceId, unit: 'statement-3' },
    });

    const stored = await findTask(storage.db, created._id);
    expect(stored?.anchor).toEqual({ kind: 'workpiece', id: workpieceId, unit: 'statement-3' });
  });

  it('goes to a group just as well as to a person', async () => {
    const groupId = new ObjectId();
    const created = await plain({ subject: { kind: 'group', id: groupId } });

    expect((await findTask(storage.db, created._id))?.subject).toEqual({
      kind: 'group',
      id: groupId,
    });
  });

  it('keeps the detail of the tool untouched', async () => {
    const detail = { schwierigkeit: 3, hinweise: ['erst lesen', 'dann schreiben'] };
    const created = await plain({ detail });

    expect((await findTask(storage.db, created._id))?.detail).toEqual(detail);
  });

  it('answers with null for a task nobody created', async () => {
    await expect(findTask(storage.db, new ObjectId())).resolves.toBeNull();
  });
});

describe('changing the state', () => {
  it('moves the field and keeps who moved it', async () => {
    const task = await plain();

    const after = await setTaskState(storage.db, task._id, {
      state: 'fertig',
      actorId: 'bob',
      reason: 'im Seminar abgenommen',
    });

    expect(after.state).toBe('fertig');
    expect((await findTask(storage.db, task._id))?.state).toBe('fertig');

    const [event] = await historyOf(task);
    expect(event).toMatchObject({
      kind: 'task-state',
      actorId: 'bob',
      reason: 'im Seminar abgenommen',
      detail: { to: 'fertig' },
    });
  });

  it('keeps the whole way, not only the last step', async () => {
    const task = await plain();

    await setTaskState(storage.db, task._id, { state: 'in Arbeit', actorId: 'alice' });
    await setTaskState(storage.db, task._id, { state: 'zur Abnahme', actorId: 'alice' });
    await setTaskState(storage.db, task._id, { state: 'fertig', actorId: 'carol' });

    const history = await historyOf(task);
    expect(history.map((event) => event.detail?.['to'])).toEqual([
      'fertig',
      'zur Abnahme',
      'in Arbeit',
    ]);

    // D5.15 is the value, D5.8 is the way there.
    expect((await findTask(storage.db, task._id))?.state).toBe('fertig');
  });

  it('rolls the field back when the trace cannot be written', async () => {
    const task = await plain();

    // Makes every insert into events fail, so the second half of the transaction
    // breaks after the first half has already run.
    await storage.db.command({
      collMod: 'events',
      validator: { $jsonSchema: { bsonType: 'object', required: ['gibt-es-nicht'] } },
      validationAction: 'error',
    });

    try {
      await expect(
        setTaskState(storage.db, task._id, { state: 'fertig', actorId: 'bob' }),
      ).rejects.toThrowError();

      // Neither half stands: without the trace the state may not have moved either.
      expect((await findTask(storage.db, task._id))?.state).toBe('offen');
      await expect(historyOf(task)).resolves.toEqual([]);
    } finally {
      await applyDefinitions(storage.db, collectionDefinitions);
    }
  });

  it('refuses a task nobody created and writes nothing', async () => {
    const before = await readEvents(storage.db, { kind: 'task-state' });
    const missing = new ObjectId();

    await expect(
      setTaskState(storage.db, missing, { state: 'fertig', actorId: 'alice' }),
    ).rejects.toThrowError(/unknown task/);

    const after = await readEvents(storage.db, { kind: 'task-state' });
    expect(after).toHaveLength(before.length);
  });
});

describe('assigning', () => {
  it('sets the subject and keeps who gave it to whom', async () => {
    const task = await plain();
    const groupId = new ObjectId();

    const after = await assignTask(storage.db, task._id, {
      subject: { kind: 'group', id: groupId },
      actorId: 'alice',
    });

    expect(after.subject).toEqual({ kind: 'group', id: groupId });

    const [event] = await historyOf(task);
    expect(event).toMatchObject({ kind: 'task-subject', actorId: 'alice' });
    expect(event?.detail?.['to']).toEqual({ kind: 'group', id: groupId });
  });

  it('can hand a task on and the handover stays readable', async () => {
    const task = await plain({ subject: { kind: 'actor', id: 'alice' } });

    await assignTask(storage.db, task._id, {
      subject: { kind: 'actor', id: 'bob' },
      actorId: 'alice',
    });
    await assignTask(storage.db, task._id, {
      subject: { kind: 'actor', id: 'carol' },
      actorId: 'bob',
    });

    const history = await historyOf(task);
    expect(history.map((event) => event.actorId)).toEqual(['bob', 'alice']);
    expect((await findTask(storage.db, task._id))?.subject).toEqual({ kind: 'actor', id: 'carol' });
  });
});

describe('reading tasks back', () => {
  it('finds everything of one subject, and narrows by state', async () => {
    const groupId = new ObjectId();
    const subject = { kind: 'group' as const, id: groupId };

    await plain({ subject, title: 'eins' });
    await plain({ subject, title: 'zwei', state: 'fertig' });
    await plain({ title: 'ohne' });

    await expect(readTasks(storage.db, { subject })).resolves.toHaveLength(2);

    const done = await readTasks(storage.db, { subject, state: 'fertig' });
    expect(done.map((task) => task.title)).toEqual(['zwei']);
  });

  it('tells the kinds apart', async () => {
    const workpieceId = new ObjectId();
    const anchor = { kind: 'workpiece', id: workpieceId };

    await plain({ anchor, kind: 'review', title: 'begutachten' });
    await plain({ anchor, kind: 'revision', title: 'überarbeiten' });

    const reviews = await readTasks(storage.db, { anchor, kind: 'review' });
    expect(reviews.map((task) => task.title)).toEqual(['begutachten']);
  });

  it('separates a whole workpiece from one place inside it', async () => {
    const workpieceId = new ObjectId();

    await plain({ anchor: { kind: 'workpiece', id: workpieceId }, title: 'ganz' });
    await plain({
      anchor: { kind: 'workpiece', id: workpieceId, unit: 'statement-3' },
      title: 'teil',
    });

    const all = await readTasks(storage.db, { anchor: { kind: 'workpiece', id: workpieceId } });
    expect(all.map((task) => task.title).toSorted()).toEqual(['ganz', 'teil']);

    const part = await readTasks(storage.db, {
      anchor: { kind: 'workpiece', id: workpieceId, unit: 'statement-3' },
    });
    expect(part.map((task) => task.title)).toEqual(['teil']);
  });

  it('gives the children of a task in their order', async () => {
    const parent = await plain({ title: 'ganze Aufgabe' });

    await plain({ title: 'dritter', parentId: parent._id, order: 3 });
    await plain({ title: 'erster', parentId: parent._id, order: 1 });
    await plain({ title: 'zweiter', parentId: parent._id, order: 2 });

    const children = await readTasks(storage.db, { parentId: parent._id });
    expect(children.map((task) => task.title)).toEqual(['erster', 'zweiter', 'dritter']);
  });

  it('gives only the tops of the trees when asked for them', async () => {
    const parent = await plain({ title: 'Wurzel', kind: 'wurzeltest' });
    await plain({ title: 'Kind', kind: 'wurzeltest', parentId: parent._id });

    const tops = await readTasks(storage.db, { kind: 'wurzeltest', parentId: TOP });
    expect(tops.map((task) => task.title)).toEqual(['Wurzel']);
  });
});
