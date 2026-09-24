import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import pino from 'pino';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createWorkpieceHub } from '../../src/realtime/hub.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createServer } from '../../src/routes/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

const tokenOf = (sub: string): string => jwt.sign({ sub, name: sub }, secret, { expiresIn: '15m' });

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;

/** Room and group come along: opening means being in a group the room bundles. */
async function freshWorkpiece(): Promise<string> {
  const workpiece = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
  await bundle(workpiece._id);
  return workpiece._id.toHexString();
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

const open = (workpieceId: string, actor: string) =>
  connectClient(`ws://127.0.0.1:${port}/ws/${workpieceId}`, ['bearer', tokenOf(actor)]);

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  server = createServer({ logger: silent });
  gateway = attachGateway({
    server,
    db: storage.db,
    hub: createWorkpieceHub({ db: storage.db, logger: silent }),
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

describe('working on one workpiece together', () => {
  it('carries a change from one client to the other and keeps it', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    const bob = await open(workpieceId, 'bob');
    await Promise.all([alice.synced, bob.synced]);

    alice.doc.getText('irgendwas').insert(0, 'hallo welt');

    expect(await waitFor(() => bob.doc.getText('irgendwas').toString() === 'hallo welt')).toBe(
      true,
    );

    const stored = await storage.db
      .collection('updates')
      .find({ workpieceId: new (await import('mongodb')).ObjectId(workpieceId) })
      .toArray();

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ actorId: 'alice' });

    await alice.close();
    await bob.close();
  });

  it('hands a returning client everything it missed', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'erst');

    const bob = await open(workpieceId, 'bob');
    await bob.synced;

    expect(await waitFor(() => bob.doc.getText('t').toString() === 'erst')).toBe(true);
    await bob.close();

    alice.doc.getText('t').insert(4, ' dann');

    const bobAgain = await open(workpieceId, 'bob');
    await bobAgain.synced;

    expect(await waitFor(() => bobAgain.doc.getText('t').toString() === 'erst dann')).toBe(true);

    await alice.close();
    await bobAgain.close();
  });

  it('carries whatever shape the tool chose, the service never looks inside', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    const bob = await open(workpieceId, 'bob');
    await Promise.all([alice.synced, bob.synced]);

    const nodes = alice.doc.getMap('nodes');
    const entity = new Y.Map<unknown>();
    entity.set('label', 'Kunde');
    entity.set('attributes', Y.Array.from(['id', 'name']));
    nodes.set('n1', entity);

    const arrived = await waitFor(() => {
      const node = bob.doc.getMap('nodes').get('n1');
      return node instanceof Y.Map && node.get('label') === 'Kunde';
    });

    expect(arrived).toBe(true);
    const copy = bob.doc.getMap('nodes').get('n1') as Y.Map<unknown>;
    expect((copy.get('attributes') as Y.Array<string>).toArray()).toEqual(['id', 'name']);

    await alice.close();
    await bob.close();
  });

  it('rebuilds the workpiece from the database once everyone has left', async () => {
    const workpieceId = await freshWorkpiece();
    const first = await open(workpieceId, 'alice');
    await first.synced;
    first.doc.getText('t').insert(0, 'bleibt');

    expect(
      await waitFor(async () => (await storage.db.collection('updates').countDocuments({})) > 0),
    ).toBe(true);

    await first.close();
    expect(await waitFor(() => gateway.countFor(workpieceId) === 0)).toBe(true);

    const later = await open(workpieceId, 'carol');
    await later.synced;

    expect(await waitFor(() => later.doc.getText('t').toString() === 'bleibt')).toBe(true);
    await later.close();
  });

  it('brings two people writing at the same moment to the same result', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    const bob = await open(workpieceId, 'bob');
    await Promise.all([alice.synced, bob.synced]);

    alice.doc.getText('t').insert(0, 'AAA');
    bob.doc.getText('t').insert(0, 'BBB');

    const same = await waitFor(
      () =>
        alice.doc.getText('t').toString() === bob.doc.getText('t').toString() &&
        alice.doc.getText('t').toString().length === 6,
    );

    expect(same).toBe(true);
    expect(alice.doc.getText('t').toString()).toContain('AAA');
    expect(alice.doc.getText('t').toString()).toContain('BBB');

    await alice.close();
    await bob.close();
  });
});
