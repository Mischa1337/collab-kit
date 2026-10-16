import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createActorNotes, noteActor, type ActorRecord } from '../../src/db/collections/actors.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_actors_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

const stored = (actorId: string) =>
  storage.db.collection<ActorRecord>('actors').findOne({ _id: actorId });

describe('noteActor', () => {
  it('creates the row on first contact, with the key from the token and no time', async () => {
    await noteActor(storage.db, 'u-1', 'Alice');

    expect(await stored('u-1')).toEqual({ _id: 'u-1', label: 'Alice' });
  });

  it('follows a name the tool has changed', async () => {
    await noteActor(storage.db, 'u-3', 'Carol');
    await noteActor(storage.db, 'u-3', 'Carol Neu');

    expect((await stored('u-3'))?.label).toBe('Carol Neu');
  });
});

describe('createActorNotes', () => {
  it('writes nothing for a token without a name', async () => {
    const note = createActorNotes(storage.db, silent);

    await note({ actorId: 'u-4' });

    expect(await stored('u-4')).toBeNull();
  });

  it('does not lose a known name when a later token omits it', async () => {
    const note = createActorNotes(storage.db, silent);

    await note({ actorId: 'u-5', label: 'Dora' });
    await note({ actorId: 'u-5' });

    expect((await stored('u-5'))?.label).toBe('Dora');
  });

  it('writes a name once and again only when it changes', async () => {
    const note = createActorNotes(storage.db, silent);
    const actors = storage.db.collection<ActorRecord>('actors');

    await note({ actorId: 'u-6', label: 'Emil' });
    // Gone behind its back: the same name is not written again, so the row stays away.
    await actors.deleteOne({ _id: 'u-6' });
    await note({ actorId: 'u-6', label: 'Emil' });
    expect(await stored('u-6')).toBeNull();

    await note({ actorId: 'u-6', label: 'Emil Neu' });
    expect((await stored('u-6'))?.label).toBe('Emil Neu');
  });
});
