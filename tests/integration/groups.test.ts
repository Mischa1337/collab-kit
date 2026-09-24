import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import {
  addMember,
  createGroup,
  findGroup,
  groupsOf,
  removeMember,
} from '../../src/db/collections/groups.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_groups_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

describe('groups', () => {
  it('starts with the members it was given, each with a moment', async () => {
    const created = await createGroup(storage.db, {
      name: 'Gruppe 3',
      createdBy: 'alice',
      members: ['alice', 'bob'],
    });

    const stored = await findGroup(storage.db, created._id);
    expect(stored?.members.map((member) => member.actorId)).toEqual(['alice', 'bob']);
    expect(stored?.members[0]).toMatchObject({ addedBy: 'alice' });
    expect(stored?.members[0]?.addedAt).toBeInstanceOf(Date);
    expect(stored?.settings).toEqual({});
  });

  it('keeps what the group means to the tool untouched', async () => {
    const settings = { role: 'moderation', rotates: true, size: { min: 2, max: 5 } };
    const created = await createGroup(storage.db, {
      name: 'Moderation',
      createdBy: 'alice',
      settings,
    });

    expect((await findGroup(storage.db, created._id))?.settings).toEqual(settings);
  });

  it('takes an actor in only once', async () => {
    const created = await createGroup(storage.db, { name: 'Gruppe 3', createdBy: 'alice' });

    await expect(
      addMember(storage.db, created._id, { actorId: 'bob', addedBy: 'alice' }),
    ).resolves.toBe(true);
    await expect(
      addMember(storage.db, created._id, { actorId: 'bob', addedBy: 'carol' }),
    ).resolves.toBe(false);

    expect((await findGroup(storage.db, created._id))?.members).toHaveLength(1);
  });

  it('lets an actor go again', async () => {
    const created = await createGroup(storage.db, {
      name: 'Gruppe 3',
      createdBy: 'alice',
      members: ['alice', 'bob'],
    });

    await expect(removeMember(storage.db, created._id, 'bob')).resolves.toBe(true);
    await expect(removeMember(storage.db, created._id, 'bob')).resolves.toBe(false);

    expect((await findGroup(storage.db, created._id))?.members.map((m) => m.actorId)).toEqual([
      'alice',
    ]);
  });

  it('finds every group an actor is in', async () => {
    const actorId = `dora-${new ObjectId().toHexString()}`;
    await createGroup(storage.db, { name: 'Eine', createdBy: 'alice', members: [actorId] });
    await createGroup(storage.db, { name: 'Zwei', createdBy: 'alice', members: [actorId] });
    await createGroup(storage.db, { name: 'Ohne', createdBy: 'alice', members: ['bob'] });

    const found = await groupsOf(storage.db, actorId);
    expect(found.map((group) => group.name).toSorted()).toEqual(['Eine', 'Zwei']);
  });
});
