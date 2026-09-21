import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { touchActor } from '../../src/db/collections/actors.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_actors_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

describe('touchActor', () => {
  it('creates the row on first contact, with the key from the token', async () => {
    const first = new Date('2026-09-18T08:00:00Z');

    const record = await touchActor(storage.db, { actorId: 'u-1', label: 'Alice' }, first);

    expect(record).toEqual({
      _id: 'u-1',
      label: 'Alice',
      firstSeenAt: first,
      lastSeenAt: first,
    });
  });

  it('keeps firstSeenAt and only moves lastSeenAt afterwards', async () => {
    const first = new Date('2026-09-18T08:00:00Z');
    const later = new Date('2026-09-18T12:30:00Z');

    await touchActor(storage.db, { actorId: 'u-2', label: 'Bob' }, first);
    const again = await touchActor(storage.db, { actorId: 'u-2', label: 'Bob' }, later);

    expect(again.firstSeenAt).toEqual(first);
    expect(again.lastSeenAt).toEqual(later);
  });

  it('follows a name the tool has changed', async () => {
    await touchActor(storage.db, { actorId: 'u-3', label: 'Carol' });
    const renamed = await touchActor(storage.db, { actorId: 'u-3', label: 'Carol Neu' });

    expect(renamed.label).toBe('Carol Neu');
  });

  it('stores an actor whose token carries no name', async () => {
    const record = await touchActor(storage.db, { actorId: 'u-4' });

    expect(record.label).toBeUndefined();
    expect(record._id).toBe('u-4');
  });

  it('does not lose a known name when a later token omits it', async () => {
    await touchActor(storage.db, { actorId: 'u-5', label: 'Dora' });
    const without = await touchActor(storage.db, { actorId: 'u-5' });

    expect(without.label).toBe('Dora');
  });
});
