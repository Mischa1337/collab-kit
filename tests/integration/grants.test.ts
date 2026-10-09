import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { may } from '../../src/auth/access.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createComment } from '../../src/db/collections/comments.ts';
import { readEvents } from '../../src/db/collections/events.ts';
import { grantsAt, removeGrant, setGrant } from '../../src/db/collections/grants.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { createTask } from '../../src/db/collections/tasks.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import type { Reference } from '../../src/model/anchor.ts';

const actor = (actorId: string) => ({ actorId });

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_grants_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

/** Every level a grant can hold at, one below the other, and a group to hold it. */
interface World {
  readonly group: ObjectId;
  readonly room: ObjectId;
  readonly workpiece: ObjectId;
  readonly task: ObjectId;
  readonly subtask: ObjectId;
  readonly comment: ObjectId;
  readonly answer: ObjectId;
}

/** A room with a workpiece, a task on it with a subtask, a comment on it with an answer. */
async function world(members: readonly string[]): Promise<World> {
  const { db } = storage;
  const group = await createGroup(db, { name: 'Team 3', createdBy: 'tutor', members });
  const room = await createRoom(db, { name: 'Übung 3', createdBy: 'tutor' });
  const workpiece = await createWorkpiece(db, { name: 'Modell', createdBy: 'tutor' });
  await addToRoom(db, room._id, { kind: 'workpiece', id: workpiece._id, addedBy: 'tutor' });

  const anchor = { kind: 'workpiece' as const, id: workpiece._id };
  const task = await createTask(db, {
    kind: 'task',
    title: 'Entwurf',
    state: 'open',
    createdBy: 'tutor',
    anchor,
  });
  const subtask = await createTask(db, {
    kind: 'task',
    title: 'Entitäten',
    state: 'open',
    createdBy: 'tutor',
    parentId: task._id,
  });
  const comment = await createComment(db, {
    kind: 'comment',
    anchor,
    createdBy: 'tutor',
    body: {},
  });
  const answer = await createComment(db, {
    kind: 'comment',
    anchor,
    createdBy: 'tutor',
    body: {},
    parentId: comment._id,
  });

  return {
    group: group._id,
    room: room._id,
    workpiece: workpiece._id,
    task: task._id,
    subtask: subtask._id,
    comment: comment._id,
    answer: answer._id,
  };
}

describe('grants', () => {
  it('keeps one grant per group and place and traces each change at the place', async () => {
    const { db } = storage;
    const { group, room } = await world([]);
    const scope = { kind: 'room' as const, id: room };

    await expect(
      setGrant(db, { groupId: group, scope, rights: ['see', 'edit'], setBy: 'tutor' }),
    ).resolves.toBe(true);
    await expect(
      setGrant(db, { groupId: group, scope, rights: ['see'], setBy: 'carol', reason: 'Abgabe' }),
    ).resolves.toBe(true);

    const [grant, ...more] = await grantsAt(db, scope);
    expect(more).toHaveLength(0);
    // The rights are replaced, who first gave them stays.
    expect(grant).toMatchObject({ groupId: group, scope, rights: ['see'], createdBy: 'tutor' });

    const events = await readEvents(db, { anchor: { kind: 'room', id: room }, kind: 'grant-set' });
    expect(events.map((event) => [event.createdBy, event.detail, event.reason])).toEqual([
      ['carol', { groupId: group, rights: ['see'] }, 'Abgabe'],
      ['tutor', { groupId: group, rights: ['see', 'edit'] }, undefined],
    ]);
  });

  it('records nothing when the rights stay as they are, and counts each right once', async () => {
    const { db } = storage;
    const { group, room } = await world([]);
    const scope = { kind: 'room' as const, id: room };

    await setGrant(db, { groupId: group, scope, rights: ['see', 'see'], setBy: 'tutor' });
    await expect(
      setGrant(db, { groupId: group, scope, rights: ['see'], setBy: 'tutor' }),
    ).resolves.toBe(false);

    expect((await grantsAt(db, scope)).map((grant) => grant.rights)).toEqual([['see']]);
    await expect(
      readEvents(db, { anchor: { kind: 'room', id: room }, kind: 'grant-set' }),
    ).resolves.toHaveLength(1);
  });

  it('keeps a grant without place once per group and traces it at the group', async () => {
    const { db } = storage;
    const { group } = await world([]);

    await setGrant(db, { groupId: group, rights: ['see'], setBy: 'dozent' });
    await setGrant(db, { groupId: group, rights: ['see', 'manage'], setBy: 'dozent' });

    const everywhere = (await grantsAt(db)).filter((grant) => grant.groupId.equals(group));
    expect(everywhere.map((grant) => grant.rights)).toEqual([['see', 'manage']]);
    expect(everywhere[0]).not.toHaveProperty('scope');
    await expect(
      readEvents(db, { anchor: { kind: 'group', id: group }, kind: 'grant-set' }),
    ).resolves.toHaveLength(2);
  });

  it('takes rights away and answers whether there were any', async () => {
    const { db } = storage;
    const { group, room } = await world([]);
    const scope = { kind: 'room' as const, id: room };
    await setGrant(db, { groupId: group, scope, rights: ['see'], setBy: 'tutor' });

    await expect(removeGrant(db, { groupId: group, scope, removedBy: 'tutor' })).resolves.toBe(
      true,
    );
    await expect(removeGrant(db, { groupId: group, scope, removedBy: 'tutor' })).resolves.toBe(
      false,
    );

    await expect(grantsAt(db, scope)).resolves.toEqual([]);
    const [removed, ...more] = await readEvents(db, {
      anchor: { kind: 'room', id: room },
      kind: 'grant-removed',
    });
    expect(more).toHaveLength(0);
    expect(removed).toMatchObject({ createdBy: 'tutor', detail: { groupId: group } });
  });
});

describe('may', () => {
  it('lets nobody do anything without a grant', async () => {
    const places = await world(['alice']);

    await expect(
      may(storage.db, actor('alice'), 'see', { kind: 'room', id: places.room }),
    ).resolves.toBe(false);
  });

  it('reaches from a room down to everything it bundles, for the members only', async () => {
    const { db } = storage;
    const places = await world(['alice']);
    await setGrant(db, {
      groupId: places.group,
      scope: { kind: 'room', id: places.room },
      rights: ['see'],
      setBy: 'tutor',
    });

    const below: Reference[] = [
      { kind: 'room', id: places.room },
      { kind: 'workpiece', id: places.workpiece },
      { kind: 'task', id: places.task },
      { kind: 'task', id: places.subtask },
      { kind: 'comment', id: places.comment },
      { kind: 'comment', id: places.answer },
    ];
    await expect(
      Promise.all(below.map((target) => may(db, actor('alice'), 'see', target))),
    ).resolves.toEqual(below.map(() => true));
    await expect(
      may(db, actor('alice'), 'edit', { kind: 'workpiece', id: places.workpiece }),
    ).resolves.toBe(false);
    await expect(
      may(db, actor('bob'), 'see', { kind: 'workpiece', id: places.workpiece }),
    ).resolves.toBe(false);
  });

  it('holds at a workpiece for what hangs on it, not for the room above', async () => {
    const { db } = storage;
    const places = await world(['alice']);
    await setGrant(db, {
      groupId: places.group,
      scope: { kind: 'workpiece', id: places.workpiece },
      rights: ['edit'],
      setBy: 'tutor',
    });

    await expect(
      may(db, actor('alice'), 'edit', { kind: 'task', id: places.subtask }),
    ).resolves.toBe(true);
    await expect(
      may(db, actor('alice'), 'edit', { kind: 'comment', id: places.comment }),
    ).resolves.toBe(true);
    await expect(may(db, actor('alice'), 'edit', { kind: 'room', id: places.room })).resolves.toBe(
      false,
    );
  });

  it('holds at a task for its subtasks and at a comment for its answers', async () => {
    const { db } = storage;
    const places = await world(['alice']);
    await Promise.all(
      [
        { kind: 'task' as const, id: places.task },
        { kind: 'comment' as const, id: places.comment },
      ].map((scope) =>
        setGrant(db, { groupId: places.group, scope, rights: ['plan'], setBy: 'tutor' }),
      ),
    );

    await expect(
      may(db, actor('alice'), 'plan', { kind: 'task', id: places.subtask }),
    ).resolves.toBe(true);
    await expect(
      may(db, actor('alice'), 'plan', { kind: 'comment', id: places.answer }),
    ).resolves.toBe(true);
    await expect(
      may(db, actor('alice'), 'plan', { kind: 'workpiece', id: places.workpiece }),
    ).resolves.toBe(false);
  });

  it('holds at a group for that group only', async () => {
    const { db } = storage;
    const leads = await world(['alice']);
    const other = await world([]);
    await setGrant(db, {
      groupId: leads.group,
      scope: { kind: 'group', id: other.group },
      rights: ['manage'],
      setBy: 'tutor',
    });

    await expect(
      may(db, actor('alice'), 'manage', { kind: 'group', id: other.group }),
    ).resolves.toBe(true);
    await expect(
      may(db, actor('alice'), 'manage', { kind: 'group', id: leads.group }),
    ).resolves.toBe(false);
  });

  it('holds everywhere without a place', async () => {
    const { db } = storage;
    const tutors = await world(['erin']);
    const elsewhere = await world([]);
    await setGrant(db, { groupId: tutors.group, rights: ['manage'], setBy: 'dozent' });

    await expect(
      may(db, actor('erin'), 'manage', { kind: 'comment', id: elsewhere.answer }),
    ).resolves.toBe(true);
    await expect(may(db, actor('erin'), 'see', { kind: 'room', id: elsewhere.room })).resolves.toBe(
      false,
    );
  });

  it('lets an actor at the top do everything without any group', async () => {
    const places = await world([]);

    await expect(
      may(storage.db, { actorId: 'dozent', top: true }, 'manage', {
        kind: 'room',
        id: places.room,
      }),
    ).resolves.toBe(true);
  });

  it('stops on a chain that runs in a circle', async () => {
    const { db } = storage;
    const places = await world(['alice']);
    // Routes never write such a chain; written by hand it must still end.
    const looped = new ObjectId();
    await db.collection('comments').insertOne({
      _id: looped,
      kind: 'comment',
      anchor: { kind: 'comment', id: looped },
      parentId: looped,
      createdBy: 'mallory',
      body: {},
      createdAt: new Date(),
    });

    await expect(may(db, actor('alice'), 'see', { kind: 'comment', id: looped })).resolves.toBe(
      false,
    );
    await setGrant(db, {
      groupId: places.group,
      scope: { kind: 'comment', id: looped },
      rights: ['see'],
      setBy: 'tutor',
    });
    await expect(may(db, actor('alice'), 'see', { kind: 'comment', id: looped })).resolves.toBe(
      true,
    );
  });
});
