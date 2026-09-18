import { ObjectId } from 'mongodb';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createDocument } from '../../src/db/documents.ts';
import { createRoom, findRoom } from '../../src/db/rooms.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_access_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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
      grants: [],
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

describe('documents', () => {
  it('starts at version 1 and is the current one', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });

    const created = await createDocument(storage.db, {
      roomId: room._id,
      name: 'Entwurf',
      actorId: 'alice',
      state: Y.encodeStateAsUpdate(new Y.Doc()),
    });

    expect(created).toMatchObject({ version: 1, isCurrent: true, name: 'Entwurf' });
    expect(created.documentId).not.toEqual(created._id);
  });

  it('returns the stored bytes unchanged, whatever the tool put in them', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });

    // The test plays the tool here: the service itself never touches a Yjs type.
    const written = new Y.Doc();
    written.getText('anything').insert(0, 'hallo welt');

    const created = await createDocument(storage.db, {
      roomId: room._id,
      name: 'Entwurf',
      actorId: 'alice',
      state: Y.encodeStateAsUpdate(written),
      contract: { unit: 'statement', identifiedBy: 'id' },
    });

    const stored = await storage.db
      .collection<typeof created>('documents')
      .findOne({ _id: created._id });

    const read = new Y.Doc();
    Y.applyUpdate(read, new Uint8Array(stored!.state.buffer));

    expect(read.getText('anything').toString()).toBe('hallo welt');
    expect(stored?.contract).toEqual({ unit: 'statement', identifiedBy: 'id' });
  });

  it('refuses a second current row for the same document', async () => {
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const created = await createDocument(storage.db, {
      roomId: room._id,
      name: 'Entwurf',
      actorId: 'alice',
      state: Y.encodeStateAsUpdate(new Y.Doc()),
    });

    await expect(
      storage.db.collection('documents').insertOne({
        ...created,
        _id: new ObjectId(),
        version: 2,
      }),
    ).rejects.toThrowError(/duplicate key/);
  });
});
