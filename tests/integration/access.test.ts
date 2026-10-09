import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import type { Right } from '../../src/model/right.ts';
import { workpieceAccess } from '../../src/auth/access.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { setGrant } from '../../src/db/collections/grants.ts';
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

describe('what someone may do with a workpiece over the socket', () => {
  /** A room with the workpiece and a group holding these rights there, which opening needs. */
  async function bundled(
    members: readonly string[],
    rights: [Right, ...Right[]] = ['see', 'edit'],
  ): Promise<ObjectId> {
    const workpiece = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const group = await createGroup(storage.db, {
      name: 'Teilnehmende',
      createdBy: 'alice',
      members,
    });

    await addToRoom(storage.db, room._id, {
      kind: 'workpiece',
      id: workpiece._id,
      addedBy: 'alice',
    });
    await setGrant(storage.db, {
      groupId: group._id,
      scope: { kind: 'room', id: room._id },
      rights,
      setBy: 'alice',
    });
    return workpiece._id;
  }

  it('lets a member of a group with see and edit at the room write', async () => {
    const workpieceId = await bundled(['alice']);

    await expect(workpieceAccess(storage.db, actor('alice'), workpieceId)).resolves.toBe('write');
  });

  it('keeps everybody else out', async () => {
    const workpieceId = await bundled(['alice']);

    await expect(workpieceAccess(storage.db, actor('mallory'), workpieceId)).resolves.toBe('none');
  });

  it('lets in who may only see, to follow along without writing', async () => {
    const workpieceId = await bundled(['alice'], ['see', 'speak']);

    await expect(workpieceAccess(storage.db, actor('alice'), workpieceId)).resolves.toBe('read');
  });

  it('keeps out who may edit but not see', async () => {
    const workpieceId = await bundled(['alice'], ['edit']);

    await expect(workpieceAccess(storage.db, actor('alice'), workpieceId)).resolves.toBe('none');
  });

  it('keeps everybody out of a workpiece that sits in no room', async () => {
    const workpiece = await createWorkpiece(storage.db, { name: 'Allein', createdBy: 'alice' });

    await expect(workpieceAccess(storage.db, actor('alice'), workpiece._id)).resolves.toBe('none');
  });

  it('keeps everybody out of a room nobody holds a grant at', async () => {
    const workpiece = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const room = await createRoom(storage.db, { name: 'Leer', createdBy: 'alice' });
    await addToRoom(storage.db, room._id, {
      kind: 'workpiece',
      id: workpiece._id,
      addedBy: 'alice',
    });

    await expect(workpieceAccess(storage.db, actor('alice'), workpiece._id)).resolves.toBe('none');
  });

  it('lets a second room in, because a workpiece may sit in several', async () => {
    const workpieceId = await bundled(['alice']);

    const other = await createRoom(storage.db, { name: 'Uebung', createdBy: 'bob' });
    const theirs = await createGroup(storage.db, {
      name: 'Andere',
      createdBy: 'bob',
      members: ['bob'],
    });
    await addToRoom(storage.db, other._id, { kind: 'workpiece', id: workpieceId, addedBy: 'bob' });
    await setGrant(storage.db, {
      groupId: theirs._id,
      scope: { kind: 'room', id: other._id },
      rights: ['see', 'edit'],
      setBy: 'bob',
    });

    // Both ways in hold, neither room knows about the other.
    await expect(workpieceAccess(storage.db, actor('alice'), workpieceId)).resolves.toBe('write');
    await expect(workpieceAccess(storage.db, actor('bob'), workpieceId)).resolves.toBe('write');
  });

  it('lets the top into every workpiece there is, and into none that is not', async () => {
    const workpiece = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const top = { actorId: 'dozent', top: true } as const;

    await expect(workpieceAccess(storage.db, top, workpiece._id)).resolves.toBe('write');
    await expect(workpieceAccess(storage.db, top, new ObjectId())).resolves.toBe('none');
  });
});
