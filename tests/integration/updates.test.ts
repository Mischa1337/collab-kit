import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { createWorkpiece, findWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { appendUpdate, readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createWorkpieceHub, type WorkpieceHub } from '../../src/realtime/hub.ts';
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
let hub: WorkpieceHub;
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
    const mark = (await findWorkpiece(storage.db, workpieceId))?.stateThrough;
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
    Y.applyUpdate(doc, new Uint8Array(row.update.buffer));
  }
  return doc;
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  server = createServer({ logger: silent });
  hub = createWorkpieceHub({ db: storage.db, logger: silent });
  gateway = attachGateway({
    server,
    db: storage.db,
    hub,
    checkToken: createTokenCheck({ key: secret }),
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
      update: new Uint8Array([1]),
      actorId: 'alice',
    });
    await appendUpdate(storage.db, {
      workpieceId,
      update: new Uint8Array([2]),
      actorId: 'bob',
    });

    const all = await readUpdatesSince(storage.db, workpieceId);
    expect(all.map((row) => row.actorId)).toEqual(['alice', 'bob']);

    const after = await readUpdatesSince(storage.db, workpieceId, first._id);
    expect(after.map((row) => row.actorId)).toEqual(['bob']);
  });

  it('keeps the updates of other workpieces out', async () => {
    const mine = await freshWorkpiece();
    const other = await freshWorkpiece();

    await appendUpdate(storage.db, {
      workpieceId: other,
      update: new Uint8Array([1]),
      actorId: 'alice',
    });

    await expect(readUpdatesSince(storage.db, mine)).resolves.toEqual([]);
  });
});

describe('folding', () => {
  it('writes the shortcut when the last one leaves', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'bleibt');
    expect(await waitFor(async () => (await countUpdates(workpieceId)) > 0)).toBe(true);

    expect((await findWorkpiece(storage.db, workpieceId))?.state).toBeUndefined();

    await alice.close();
    expect(await foldedBeyond(workpieceId)).toBe(true);

    const stored = await findWorkpiece(storage.db, workpieceId);
    expect(stored?.state).toBeDefined();

    const folded = new Y.Doc();
    Y.applyUpdate(folded, new Uint8Array(stored!.state!.buffer));
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
    expect((await findWorkpiece(storage.db, workpieceId))?.state).toBeDefined();
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

    const first = await findWorkpiece(storage.db, workpieceId);

    const bob = await open(workpieceId, 'bob');
    await bob.synced;
    bob.doc.getText('t').insert(4, ' zwei');
    expect(await waitFor(async () => (await countUpdates(workpieceId)) === 2)).toBe(true);
    await bob.close();
    expect(await foldedBeyond(workpieceId, first?.stateThrough)).toBe(true);

    const second = await findWorkpiece(storage.db, workpieceId);
    expect(second?.stateThrough).not.toEqual(first?.stateThrough);

    const folded = new Y.Doc();
    Y.applyUpdate(folded, new Uint8Array(second!.state!.buffer));
    expect(folded.getText('t').toString()).toBe('eins zwei');
  });

  it('can be asked for on a workpiece nobody has open and does not keep it open', async () => {
    const workpieceId = await freshWorkpiece();
    await appendUpdate(storage.db, {
      workpieceId,
      update: Y.encodeStateAsUpdate(writtenBy('geschlossen')),
      actorId: 'carol',
    });

    await expect(hub.fold(workpieceId)).resolves.toBe(true);

    const stored = await findWorkpiece(storage.db, workpieceId);
    const folded = new Y.Doc();
    Y.applyUpdate(folded, new Uint8Array(stored!.state!.buffer));

    expect(folded.getText('t').toString()).toBe('geschlossen');
    expect(gateway.countFor(workpieceId.toHexString())).toBe(0);
  });

  it('does nothing when there is nothing new to fold', async () => {
    const workpieceId = await freshWorkpiece();

    // Never a change, so there is no cut to write.
    await expect(hub.fold(workpieceId)).resolves.toBe(false);

    await appendUpdate(storage.db, {
      workpieceId,
      update: Y.encodeStateAsUpdate(writtenBy('etwas')),
      actorId: 'alice',
    });

    await expect(hub.fold(workpieceId)).resolves.toBe(true);
    await expect(hub.fold(workpieceId)).resolves.toBe(false);
  });

  it('loses nothing when a change arrives in the same moment', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'vorher');
    const folding = hub.fold(workpieceId);
    alice.doc.getText('t').insert(6, ' nachher');
    await folding;

    await alice.close();
    expect(await waitFor(() => gateway.countFor(workpieceId.toHexString()) === 0)).toBe(true);

    const bob = await open(workpieceId, 'bob');
    await bob.synced;
    expect(await waitFor(() => bob.doc.getText('t').toString() === 'vorher nachher')).toBe(true);
    await bob.close();
  });
});

/** Plays the tool: the service itself never builds a Yjs type. */
function writtenBy(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, text);
  return doc;
}
