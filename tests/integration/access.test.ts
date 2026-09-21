import { ObjectId } from 'mongodb';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createDocument, findDocument, foldState } from '../../src/db/documents.ts';
import { addMember, createGroup, findGroup, groupsOf, removeMember } from '../../src/db/groups.ts';
import { mayOpenDocument } from '../../src/auth/access.ts';
import {
  addToRoom,
  createRoom,
  findRoom,
  removeFromRoom,
  roomsContaining,
} from '../../src/db/rooms.ts';

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

describe('documents', () => {
  it('is born empty, without a state and without a shortcut', async () => {
    const created = await createDocument(storage.db, { name: 'Entwurf', createdBy: 'alice' });

    expect(created).toMatchObject({ name: 'Entwurf', createdBy: 'alice', contract: {} });
    expect(created.state).toBeUndefined();
    expect(created.stateThrough).toBeUndefined();
  });

  it('keeps the contract of the tool untouched', async () => {
    const contract = { unit: 'statement', identifiedBy: 'id', nested: { whatever: [1, 2] } };

    const created = await createDocument(storage.db, {
      name: 'Entwurf',
      createdBy: 'alice',
      contract,
    });

    const stored = await findDocument(storage.db, created._id);
    expect(stored?.contract).toEqual(contract);
  });

  it('answers with null for a document nobody created', async () => {
    await expect(findDocument(storage.db, new ObjectId())).resolves.toBeNull();
  });
});

/** Plays the tool: the service itself never touches a Yjs type. */
function typed(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('anything').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

describe('folding', () => {
  it('writes the shortcut and returns the bytes unchanged', async () => {
    const created = await createDocument(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const through = new ObjectId();

    await expect(
      foldState(storage.db, { documentId: created._id, state: typed('hallo welt'), through }),
    ).resolves.toBe(true);

    const stored = await findDocument(storage.db, created._id);
    const read = new Y.Doc();
    Y.applyUpdate(read, new Uint8Array(stored!.state!.buffer));

    expect(read.getText('anything').toString()).toBe('hallo welt');
    expect(stored?.stateThrough).toEqual(through);
  });

  it('refuses to push an older state over a newer one', async () => {
    const created = await createDocument(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const first = new ObjectId();

    await foldState(storage.db, { documentId: created._id, state: typed('erst'), through: first });

    // Somebody who still believes the document was never folded.
    await expect(
      foldState(storage.db, {
        documentId: created._id,
        state: typed('daneben'),
        through: new ObjectId(),
      }),
    ).resolves.toBe(false);

    await expect(
      foldState(storage.db, {
        documentId: created._id,
        state: typed('danach'),
        through: new ObjectId(),
        expected: first,
      }),
    ).resolves.toBe(true);
  });
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
    expect(stored?.members[0]?.joinedAt).toBeInstanceOf(Date);
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

const actor = (actorId: string) => ({ actorId });

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
