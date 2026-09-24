import { ObjectId } from 'mongodb';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import {
  createWorkpiece,
  workpieceExists,
  findWorkpiece,
  foldState,
} from '../../src/db/collections/workpieces.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_workpieces_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

/** Plays the tool: the service itself never touches a Yjs type. */
function typed(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('anything').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

describe('workpieces', () => {
  it('is born empty, without a state and without a shortcut', async () => {
    const created = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });

    expect(created).toMatchObject({ name: 'Entwurf', createdBy: 'alice', contract: {} });
    expect(created.state).toBeUndefined();
    expect(created.stateThrough).toBeUndefined();
  });

  it('keeps the contract of the tool untouched', async () => {
    const contract = { unit: 'statement', identifiedBy: 'id', nested: { whatever: [1, 2] } };

    const created = await createWorkpiece(storage.db, {
      name: 'Entwurf',
      createdBy: 'alice',
      contract,
    });

    const stored = await findWorkpiece(storage.db, created._id);
    expect(stored?.contract).toEqual(contract);
  });

  it('answers with null for a workpiece nobody created', async () => {
    await expect(findWorkpiece(storage.db, new ObjectId())).resolves.toBeNull();
  });

  it('tells whether a workpiece is there', async () => {
    const created = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });

    await expect(workpieceExists(storage.db, created._id)).resolves.toBe(true);
    await expect(workpieceExists(storage.db, new ObjectId())).resolves.toBe(false);
  });
});

describe('folding', () => {
  it('writes the shortcut and returns the bytes unchanged', async () => {
    const created = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const through = new ObjectId();

    await expect(
      foldState(storage.db, { workpieceId: created._id, state: typed('hallo welt'), through }),
    ).resolves.toBe(true);

    const stored = await findWorkpiece(storage.db, created._id);
    const read = new Y.Doc();
    Y.applyUpdate(read, new Uint8Array(stored!.state!.buffer));

    expect(read.getText('anything').toString()).toBe('hallo welt');
    expect(stored?.stateThrough).toEqual(through);
  });

  it('refuses to push an older state over a newer one', async () => {
    const created = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const first = new ObjectId();

    await foldState(storage.db, { workpieceId: created._id, state: typed('erst'), through: first });

    // Somebody who still believes the workpiece was never folded.
    await expect(
      foldState(storage.db, {
        workpieceId: created._id,
        state: typed('daneben'),
        through: new ObjectId(),
      }),
    ).resolves.toBe(false);

    await expect(
      foldState(storage.db, {
        workpieceId: created._id,
        state: typed('danach'),
        through: new ObjectId(),
        expected: first,
      }),
    ).resolves.toBe(true);
  });
});
