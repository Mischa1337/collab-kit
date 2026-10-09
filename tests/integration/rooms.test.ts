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
import { readEvents } from '../../src/db/collections/events.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_rooms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;

const traces = (roomId: ObjectId, kind: string) =>
  readEvents(storage.db, { anchor: { kind: 'room', id: roomId }, kind });

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
      references: [],
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
  it('takes a reference in and leaves a trace of when and by whom', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const workpieceId = new ObjectId();

    await expect(
      addToRoom(storage.db, room._id, { kind: 'workpiece', id: workpieceId, addedBy: 'alice' }),
    ).resolves.toBe(true);

    const stored = await findRoom(storage.db, room._id);
    expect(stored?.references).toEqual([{ kind: 'workpiece', id: workpieceId }]);

    const added = await traces(room._id, 'reference-added');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      createdBy: 'alice',
      detail: { kind: 'workpiece', id: workpieceId },
    });
    expect(added[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('adds the same thing only once', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const id = new ObjectId();

    await addToRoom(storage.db, room._id, { kind: 'workpiece', id, addedBy: 'alice' });
    await expect(
      addToRoom(storage.db, room._id, { kind: 'workpiece', id, addedBy: 'bob' }),
    ).resolves.toBe(false);

    expect((await findRoom(storage.db, room._id))?.references).toHaveLength(1);
    await expect(traces(room._id, 'reference-added')).resolves.toHaveLength(1);
  });

  it('takes a reference out again and leaves the rest alone', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const going = new ObjectId();
    const staying = new ObjectId();

    await addToRoom(storage.db, room._id, { kind: 'workpiece', id: going, addedBy: 'alice' });
    await addToRoom(storage.db, room._id, { kind: 'workpiece', id: staying, addedBy: 'alice' });

    const removal = { kind: 'workpiece' as const, id: going, removedBy: 'alice' };
    await expect(removeFromRoom(storage.db, room._id, removal)).resolves.toBe(true);
    await expect(removeFromRoom(storage.db, room._id, removal)).resolves.toBe(false);

    const stored = await findRoom(storage.db, room._id);
    expect(stored?.references.map((reference) => reference.id)).toEqual([staying]);

    const removed = await traces(room._id, 'reference-removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      createdBy: 'alice',
      detail: { kind: 'workpiece', id: going },
    });
  });

  it('finds every room the same thing sits in', async () => {
    const workpieceId = new ObjectId();
    const first = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const second = await createRoom(storage.db, { name: 'Uebung', createdBy: 'bob' });
    const other = await createRoom(storage.db, { name: 'Daneben', createdBy: 'carol' });

    await addToRoom(storage.db, first._id, {
      kind: 'workpiece',
      id: workpieceId,
      addedBy: 'alice',
    });
    await addToRoom(storage.db, second._id, { kind: 'workpiece', id: workpieceId, addedBy: 'bob' });
    await addToRoom(storage.db, other._id, {
      kind: 'workpiece',
      id: new ObjectId(),
      addedBy: 'carol',
    });

    const found = await roomsContaining(storage.db, { kind: 'workpiece', id: workpieceId });
    expect(found.map((room) => room.name).toSorted()).toEqual(['Seminar', 'Uebung']);
  });

  it('answers with nothing for a thing no room bundles', async () => {
    await expect(
      roomsContaining(storage.db, { kind: 'workpiece', id: new ObjectId() }),
    ).resolves.toEqual([]);
  });
});
