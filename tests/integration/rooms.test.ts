import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import {
  addToRoom,
  createRoom,
  findRoom,
  removeFromRoom,
  roomsContaining,
} from '../../src/db/collections/rooms.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_rooms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

describe('rooms', () => {
  it('stores a room and reads it back', async () => {
    const created = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });

    await expect(findRoom(storage.db, created._id)).resolves.toMatchObject({
      name: 'Seminar',
      createdBy: 'alice',
      settings: {},
      contains: [],
    });
  });

  it('keeps the settings of the tool untouched', async () => {
    const settings = { concurrency: 'free', feedback: { anonymous: true }, whatever: [1, 2] };

    const created = await createRoom(storage.db, {
      name: 'Uebung',
      createdBy: 'bob',
      settings,
    });

    const stored = await findRoom(storage.db, created._id);
    expect(stored?.settings).toEqual(settings);
  });

  it('answers with null for a room nobody created', async () => {
    await expect(findRoom(storage.db, new ObjectId())).resolves.toBeNull();
  });
});

describe('what a room bundles', () => {
  it('takes a reference in and notes when and by whom', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const documentId = new ObjectId();

    await expect(
      addToRoom(storage.db, room._id, { kind: 'document', id: documentId, addedBy: 'alice' }),
    ).resolves.toBe(true);

    const stored = await findRoom(storage.db, room._id);
    expect(stored?.contains).toHaveLength(1);
    expect(stored?.contains[0]).toMatchObject({
      kind: 'document',
      id: documentId,
      addedBy: 'alice',
    });
    expect(stored?.contains[0]?.addedAt).toBeInstanceOf(Date);
  });

  it('adds the same thing only once', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const id = new ObjectId();

    await addToRoom(storage.db, room._id, { kind: 'group', id, addedBy: 'alice' });
    await expect(
      addToRoom(storage.db, room._id, { kind: 'group', id, addedBy: 'bob' }),
    ).resolves.toBe(false);

    expect((await findRoom(storage.db, room._id))?.contains).toHaveLength(1);
  });

  it('tells the kinds apart, even under the same id', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const id = new ObjectId();

    await addToRoom(storage.db, room._id, { kind: 'document', id, addedBy: 'alice' });
    await addToRoom(storage.db, room._id, { kind: 'group', id, addedBy: 'alice' });

    expect((await findRoom(storage.db, room._id))?.contains).toHaveLength(2);
  });

  it('carries a kind the service has never heard of', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });

    await addToRoom(storage.db, room._id, {
      kind: 'whatever-the-tool-brings',
      id: 'a key of its own',
      addedBy: 'alice',
    });

    expect((await findRoom(storage.db, room._id))?.contains[0]).toMatchObject({
      kind: 'whatever-the-tool-brings',
      id: 'a key of its own',
    });
  });

  it('takes a reference out again and leaves the rest alone', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const going = new ObjectId();
    const staying = new ObjectId();

    await addToRoom(storage.db, room._id, { kind: 'document', id: going, addedBy: 'alice' });
    await addToRoom(storage.db, room._id, { kind: 'document', id: staying, addedBy: 'alice' });

    await expect(
      removeFromRoom(storage.db, room._id, { kind: 'document', id: going }),
    ).resolves.toBe(true);
    await expect(
      removeFromRoom(storage.db, room._id, { kind: 'document', id: going }),
    ).resolves.toBe(false);

    const stored = await findRoom(storage.db, room._id);
    expect(stored?.contains.map((entry) => entry.id)).toEqual([staying]);
  });

  it('finds every room the same thing sits in', async () => {
    const documentId = new ObjectId();
    const first = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const second = await createRoom(storage.db, { name: 'Uebung', createdBy: 'bob' });
    const other = await createRoom(storage.db, { name: 'Daneben', createdBy: 'carol' });

    await addToRoom(storage.db, first._id, { kind: 'document', id: documentId, addedBy: 'alice' });
    await addToRoom(storage.db, second._id, { kind: 'document', id: documentId, addedBy: 'bob' });
    await addToRoom(storage.db, other._id, {
      kind: 'document',
      id: new ObjectId(),
      addedBy: 'carol',
    });

    const found = await roomsContaining(storage.db, { kind: 'document', id: documentId });
    expect(found.map((room) => room.name).toSorted()).toEqual(['Seminar', 'Uebung']);
  });

  it('answers with nothing for a thing no room bundles', async () => {
    await expect(
      roomsContaining(storage.db, { kind: 'document', id: new ObjectId() }),
    ).resolves.toEqual([]);
  });
});
