import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { mayOpenDocument } from '../../src/auth/access.ts';
import { createDocument } from '../../src/db/collections/documents.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';

const actor = (actorId: string) => ({ actorId });

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

describe('who may open a document', () => {
  /** A room that bundles the document and a group, which is what opening needs. */
  async function bundled(members: readonly string[]): Promise<ObjectId> {
    const document = await createDocument(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const group = await createGroup(storage.db, {
      name: 'Teilnehmende',
      createdBy: 'alice',
      members,
    });

    await addToRoom(storage.db, room._id, {
      kind: 'document',
      id: document._id,
      addedBy: 'alice',
    });
    await addToRoom(storage.db, room._id, { kind: 'group', id: group._id, addedBy: 'alice' });
    return document._id;
  }

  it('lets a member of a group in the room in', async () => {
    const documentId = await bundled(['alice']);

    await expect(
      mayOpenDocument({ db: storage.db, actor: actor('alice'), documentId }),
    ).resolves.toBe(true);
  });

  it('keeps everybody else out', async () => {
    const documentId = await bundled(['alice']);

    await expect(
      mayOpenDocument({ db: storage.db, actor: actor('mallory'), documentId }),
    ).resolves.toBe(false);
  });

  it('keeps everybody out of a document that sits in no room', async () => {
    const document = await createDocument(storage.db, { name: 'Allein', createdBy: 'alice' });

    await expect(
      mayOpenDocument({ db: storage.db, actor: actor('alice'), documentId: document._id }),
    ).resolves.toBe(false);
  });

  it('keeps everybody out of a room that holds no group', async () => {
    const document = await createDocument(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const room = await createRoom(storage.db, { name: 'Leer', createdBy: 'alice' });
    await addToRoom(storage.db, room._id, {
      kind: 'document',
      id: document._id,
      addedBy: 'alice',
    });

    await expect(
      mayOpenDocument({ db: storage.db, actor: actor('alice'), documentId: document._id }),
    ).resolves.toBe(false);
  });

  it('lets a second room in, because a document may sit in several', async () => {
    const documentId = await bundled(['alice']);

    const other = await createRoom(storage.db, { name: 'Uebung', createdBy: 'bob' });
    const theirs = await createGroup(storage.db, {
      name: 'Andere',
      createdBy: 'bob',
      members: ['bob'],
    });
    await addToRoom(storage.db, other._id, { kind: 'document', id: documentId, addedBy: 'bob' });
    await addToRoom(storage.db, other._id, { kind: 'group', id: theirs._id, addedBy: 'bob' });

    // Both ways in hold, neither room knows about the other.
    await expect(
      mayOpenDocument({ db: storage.db, actor: actor('alice'), documentId }),
    ).resolves.toBe(true);
    await expect(
      mayOpenDocument({ db: storage.db, actor: actor('bob'), documentId }),
    ).resolves.toBe(true);
  });

  it('ignores a reference of a kind the service does not keep', async () => {
    const document = await createDocument(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const room = await createRoom(storage.db, { name: 'Fremd', createdBy: 'alice' });

    await addToRoom(storage.db, room._id, {
      kind: 'document',
      id: document._id,
      addedBy: 'alice',
    });
    await addToRoom(storage.db, room._id, {
      kind: 'group',
      id: 'a key the tool made up',
      addedBy: 'alice',
    });

    await expect(
      mayOpenDocument({ db: storage.db, actor: actor('alice'), documentId: document._id }),
    ).resolves.toBe(false);
  });
});
