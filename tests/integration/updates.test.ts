import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import pino from 'pino';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { createWorkpiece, findWorkpieceWithFold } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { appendUpdate, readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createWorkpieceHub } from '../../src/realtime/hub.ts';
import { foldNow, loadWorkpiece, storeUpdate } from '../../src/realtime/persistence.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createServer } from '../../src/routes/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_updates_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;

/** Room and group come along: opening means being in a group the room bundles. */
async function freshWorkpiece(): Promise<ObjectId> {
  const workpiece = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
  await bundle(workpiece._id);
  return workpiece._id;
}

async function bundle(workpieceId: import('mongodb').ObjectId): Promise<void> {
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  const group = await createGroup(storage.db, {
    name: 'Teilnehmende',
    createdBy: 'alice',
    members: ['alice', 'bob', 'carol'],
  });
  await addToRoom(storage.db, room._id, { kind: 'workpiece', id: workpieceId, addedBy: 'alice' });
  await addToRoom(storage.db, room._id, { kind: 'group', id: group._id, addedBy: 'alice' });
}

const open = (workpieceId: ObjectId, actor: string) =>
  connectClient(`ws://127.0.0.1:${port}/ws/${workpieceId.toHexString()}`, [
    'bearer',
    jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' }),
  ]);

const countUpdates = (workpieceId: ObjectId) =>
  storage.db.collection('updates').countDocuments({ workpieceId });

/**
 * Folding happens after the last connection is already gone from the count, so the
 * stored mark is what to wait for and not the count.
 */
const foldedBeyond = (workpieceId: ObjectId, previous?: ObjectId) =>
  waitFor(async () => {
    const mark = (await findWorkpieceWithFold(storage.db, workpieceId))?.fold?.upToUpdateId;
    return mark !== undefined && (previous === undefined || !mark.equals(previous));
  });

/**
 * Rebuilds a state from the updates alone, ignoring the folded shortcut. gc is off,
 * because a document with collection on would throw away what an earlier state still
 * contained while it replays.
 */
async function replay(workpieceId: ObjectId, until?: ObjectId): Promise<Y.Doc> {
  const doc = new Y.Doc({ gc: false });
  for (const row of await readUpdatesSince(storage.db, workpieceId)) {
    if (until !== undefined && row._id.toHexString() > until.toHexString()) {
      break;
    }
    Y.applyUpdate(doc, new Uint8Array(row.bytes.buffer));
  }
  return doc;
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  server = createServer({ logger: silent });
  gateway = attachGateway({
    server,
    db: storage.db,
    hub: createWorkpieceHub({ db: storage.db, logger: silent }),
    checkToken: createTokenCheck({ key: secret, algorithm: 'HS256' }),
    logger: silent,
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await storage.db.dropDatabase();
  await storage.close();
});

describe('the stream of updates', () => {
  it('reads everything from the beginning when no cut is given', async () => {
    const workpieceId = await freshWorkpiece();

    const first = await appendUpdate(storage.db, {
      workpieceId,
      bytes: new Uint8Array([1]),
      createdBy: 'alice',
    });
    await appendUpdate(storage.db, {
      workpieceId,
      bytes: new Uint8Array([2]),
      createdBy: 'bob',
    });

    const all = await readUpdatesSince(storage.db, workpieceId);
    expect(all.map((row) => row.createdBy)).toEqual(['alice', 'bob']);

    const after = await readUpdatesSince(storage.db, workpieceId, first._id);
    expect(after.map((row) => row.createdBy)).toEqual(['bob']);
  });

  it('keeps the updates of other workpieces out', async () => {
    const mine = await freshWorkpiece();
    const other = await freshWorkpiece();

    await appendUpdate(storage.db, {
      workpieceId: other,
      bytes: new Uint8Array([1]),
      createdBy: 'alice',
    });

    await expect(readUpdatesSince(storage.db, mine)).resolves.toEqual([]);
  });
});

describe('loading', () => {
  it('names the stored change that cannot be applied, so it can be found', async () => {
    const workpieceId = await freshWorkpiece();
    const broken = await appendUpdate(storage.db, {
      workpieceId,
      bytes: new Uint8Array([1, 2, 3]),
      createdBy: 'alice',
    });

    await expect(loadWorkpiece(storage.db, workpieceId)).rejects.toThrowError(
      `update ${broken._id.toHexString()} cannot be applied`,
    );
  });
});

describe('folding', () => {
  it('waits for as many changes again after a fold that failed', async () => {
    // Nothing listens on port 9, so the fold fails after the short selection timeout.
    const unreachable = new MongoClient(
      'mongodb://127.0.0.1:9/?directConnection=true&serverSelectionTimeoutMS=300',
    );
    const stored = {
      workpieceId: new ObjectId(),
      queue: Promise.resolve(),
      lastUpdateId: new ObjectId(),
      updatesSinceFoldAttempt: 400,
    };

    await expect(foldNow(unreachable.db('nirgends'), stored, new Y.Doc())).rejects.toThrow();
    expect(stored.updatesSinceFoldAttempt).toBe(0);

    await unreachable.close();
  });

  it('writes the shortcut when the last one leaves', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'bleibt');
    expect(await waitFor(async () => (await countUpdates(workpieceId)) > 0)).toBe(true);

    expect((await findWorkpieceWithFold(storage.db, workpieceId))?.fold).toBeUndefined();

    await alice.close();
    expect(await foldedBeyond(workpieceId)).toBe(true);

    const stored = await findWorkpieceWithFold(storage.db, workpieceId);
    expect(stored?.fold).toBeDefined();

    const folded = new Y.Doc();
    Y.applyUpdate(folded, new Uint8Array(stored!.fold!.state.buffer));
    expect(folded.getText('t').toString()).toBe('bleibt');
  });

  it('deletes nothing, so every earlier state stays reachable', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'erst');
    expect(await waitFor(async () => (await countUpdates(workpieceId)) === 1)).toBe(true);
    const afterFirst = (await readUpdatesSince(storage.db, workpieceId))[0]!._id;

    alice.doc.getText('t').insert(4, ' dann');
    expect(await waitFor(async () => (await countUpdates(workpieceId)) === 2)).toBe(true);

    await alice.close();
    expect(await foldedBeyond(workpieceId)).toBe(true);

    // Folded, and yet both updates are still there and still tell the whole story.
    expect((await findWorkpieceWithFold(storage.db, workpieceId))?.fold).toBeDefined();
    expect(await countUpdates(workpieceId)).toBe(2);

    expect((await replay(workpieceId)).getText('t').toString()).toBe('erst dann');
    expect((await replay(workpieceId, afterFirst)).getText('t').toString()).toBe('erst');
  });

  it('loads the same content over the shortcut as before', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'inhalt');
    expect(await waitFor(async () => (await countUpdates(workpieceId)) > 0)).toBe(true);
    await alice.close();
    expect(await foldedBeyond(workpieceId)).toBe(true);

    const bob = await open(workpieceId, 'bob');
    await bob.synced;
    expect(await waitFor(() => bob.doc.getText('t').toString() === 'inhalt')).toBe(true);
    await bob.close();
  });

  it('carries on where it stopped and folds again', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'eins');
    expect(await waitFor(async () => (await countUpdates(workpieceId)) === 1)).toBe(true);
    await alice.close();
    expect(await foldedBeyond(workpieceId)).toBe(true);

    const first = await findWorkpieceWithFold(storage.db, workpieceId);

    const bob = await open(workpieceId, 'bob');
    await bob.synced;
    bob.doc.getText('t').insert(4, ' zwei');
    expect(await waitFor(async () => (await countUpdates(workpieceId)) === 2)).toBe(true);
    await bob.close();
    expect(await foldedBeyond(workpieceId, first?.fold?.upToUpdateId)).toBe(true);

    const second = await findWorkpieceWithFold(storage.db, workpieceId);
    expect(second?.fold?.upToUpdateId).not.toEqual(first?.fold?.upToUpdateId);

    const folded = new Y.Doc();
    Y.applyUpdate(folded, new Uint8Array(second!.fold!.state.buffer));
    expect(folded.getText('t').toString()).toBe('eins zwei');
  });

  it('writes the whole state as the new fold', async () => {
    const workpieceId = await freshWorkpiece();
    await appendUpdate(storage.db, {
      workpieceId,
      bytes: Y.encodeStateAsUpdate(writtenBy('geschlossen')),
      createdBy: 'carol',
    });
    const { doc, stored } = await loadWorkpiece(storage.db, workpieceId);

    await expect(foldNow(storage.db, stored, doc)).resolves.toBe(true);

    const record = await findWorkpieceWithFold(storage.db, workpieceId);
    const folded = new Y.Doc();
    Y.applyUpdate(folded, new Uint8Array(record!.fold!.state.buffer));
    expect(folded.getText('t').toString()).toBe('geschlossen');
  });

  it('does nothing when there is nothing new to fold', async () => {
    const workpieceId = await freshWorkpiece();

    // Never a change, so there is no cut to write.
    const empty = await loadWorkpiece(storage.db, workpieceId);
    await expect(foldNow(storage.db, empty.stored, empty.doc)).resolves.toBe(false);

    await appendUpdate(storage.db, {
      workpieceId,
      bytes: Y.encodeStateAsUpdate(writtenBy('etwas')),
      createdBy: 'alice',
    });

    const { doc, stored } = await loadWorkpiece(storage.db, workpieceId);
    await expect(foldNow(storage.db, stored, doc)).resolves.toBe(true);
    await expect(foldNow(storage.db, stored, doc)).resolves.toBe(false);
  });

  it('loses nothing and doubles nothing when a change is in memory but not yet stored', async () => {
    const workpieceId = await freshWorkpiece();
    await appendUpdate(storage.db, {
      workpieceId,
      bytes: Y.encodeStateAsUpdate(writtenBy('vorher')),
      createdBy: 'alice',
    });
    const { doc, stored } = await loadWorkpiece(storage.db, workpieceId);

    // Applied but not stored yet, as between a message arriving and its turn in the queue.
    const pending: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => pending.push(update));
    doc.getText('t').insert(6, ' nachher');
    await foldNow(storage.db, stored, doc);
    await storeUpdate(storage.db, stored, pending[0]!, 'alice');

    const reloaded = await loadWorkpiece(storage.db, workpieceId);
    expect(reloaded.doc.getText('t').toString()).toBe('vorher nachher');
  });

  it('lets only one of two folds win, and the loser costs nothing', async () => {
    const workpieceId = await freshWorkpiece();
    await appendUpdate(storage.db, {
      workpieceId,
      bytes: Y.encodeStateAsUpdate(writtenBy('eins')),
      createdBy: 'alice',
    });

    // Two working copies of the same workpiece, as two processes would hold them.
    const first = await loadWorkpiece(storage.db, workpieceId);
    const second = await loadWorkpiece(storage.db, workpieceId);
    const later: Uint8Array[] = [];
    second.doc.on('update', (update: Uint8Array) => later.push(update));
    second.doc.getText('t').insert(4, ' zwei');
    await storeUpdate(storage.db, second.stored, later[0]!, 'bob');

    await expect(foldNow(storage.db, first.stored, first.doc)).resolves.toBe(true);
    await expect(foldNow(storage.db, second.stored, second.doc)).resolves.toBe(false);

    // The winner's fold stays, the loser's mark does not move, and nothing is lost.
    const record = await findWorkpieceWithFold(storage.db, workpieceId);
    expect(record?.fold?.upToUpdateId).toEqual(first.stored.lastUpdateId);
    expect(second.stored.foldedUpToUpdateId).toBeUndefined();

    const reloaded = await loadWorkpiece(storage.db, workpieceId);
    expect(reloaded.doc.getText('t').toString()).toBe('eins zwei');
  });
});

/** Plays the tool: the service itself never builds a Yjs type. */
function writtenBy(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, text);
  return doc;
}
