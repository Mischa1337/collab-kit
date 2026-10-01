import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import { WebSocket } from 'ws';
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

const open = (workpieceId: string, actor: string, doc?: Y.Doc) =>
  connectClient(`ws://127.0.0.1:${port}/ws/${workpieceId}`, ['bearer', tokenOf(actor)], doc);

/** One awareness entry as a client sends it: which client, its clock, and its state. */
function presence(clientId: number, clock: number, state: unknown): Uint8Array {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, 1);
  encoding.writeVarUint(update, clientId);
  encoding.writeVarUint(update, clock);
  encoding.writeVarString(update, JSON.stringify(state));

  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 1);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
  return encoding.toUint8Array(message);
}

interface Watcher {
  readonly socket: WebSocket;
  /** The latest awareness state this connection received per client; null means gone. */
  readonly seen: Map<number, unknown>;
  readonly closed: Promise<number>;
}

/** A bare connection that records every awareness state it is sent. */
async function watch(workpieceId: string, actor: string): Promise<Watcher> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${workpieceId}`, [
    'bearer',
    tokenOf(actor),
  ]);
  const seen = new Map<number, unknown>();
  const closed = new Promise<number>((resolve) => {
    socket.on('close', (code) => resolve(code));
  });

  socket.on('message', (data: Buffer) => {
    const message = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(message) !== 1) {
      return;
    }
    const update = decoding.createDecoder(decoding.readVarUint8Array(message));
    const count = decoding.readVarUint(update);
    for (let entry = 0; entry < count; entry += 1) {
      const clientId = decoding.readVarUint(update);
      decoding.readVarUint(update);
      seen.set(clientId, JSON.parse(decoding.readVarString(update)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, seen, closed };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes the database refuse every new change, as it would while it is down, or accept again. */
async function refuseChanges(refuse: boolean): Promise<void> {
  if (refuse) {
    await storage.db.command({
      collMod: 'updates',
      validator: { $jsonSchema: { required: ['refused'] } },
      validationAction: 'error',
    });
  } else {
    await applyDefinitions(storage.db, collectionDefinitions);
  }
}

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
    expect(stored[0]).toMatchObject({ createdBy: 'alice' });

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
    expect(await waitFor(() => gateway.countFor(new ObjectId(workpieceId)) === 0)).toBe(true);

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

  it('closes the workpiece for everyone when a change cannot be stored, and heals', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    const bob = await open(workpieceId, 'bob');
    await Promise.all([alice.synced, bob.synced]);

    await refuseChanges(true);
    alice.doc.getText('t').insert(0, 'im Ausfall');
    await expect(Promise.all([alice.closed, bob.closed])).resolves.toEqual([1011, 1011]);
    await refuseChanges(false);

    // Both come back with what they hold, as a client does after losing the connection.
    const aliceAgain = await open(workpieceId, 'alice', alice.doc);
    const bobAgain = await open(workpieceId, 'bob', bob.doc);
    expect(await waitFor(() => bobAgain.doc.getText('t').toString() === 'im Ausfall')).toBe(true);

    const stored = await storage.db
      .collection('updates')
      .find({ workpieceId: new ObjectId(workpieceId) })
      .toArray();
    expect(stored.map((row) => row['createdBy'])).toEqual(['alice']);

    await aliceAgain.close();
    await bobAgain.close();
  });
});

describe('who is there', () => {
  it('shows somebody alone nobody else, not even the service', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await watch(workpieceId, 'alice');

    await pause(200);
    expect(alice.seen.size).toBe(0);

    alice.socket.close();
  });

  it('sends a presence back to its sender too, as a sign of life', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await watch(workpieceId, 'alice');

    alice.socket.send(presence(111, 1, { name: 'alice' }));

    expect(await waitFor(() => alice.seen.has(111))).toBe(true);
    expect(alice.seen.get(111)).toEqual({ name: 'alice' });
    alice.socket.close();
  });

  it('refuses a presence that belongs to somebody else', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await watch(workpieceId, 'alice');
    alice.socket.send(presence(222, 1, { name: 'alice' }));
    const bob = await watch(workpieceId, 'bob');
    expect(await waitFor(() => bob.seen.has(222))).toBe(true);

    // A clock far ahead would lock alice out of her own entry, were it taken.
    bob.socket.send(presence(222, 99, { name: 'mallory' }));
    await expect(bob.closed).resolves.toBe(1008);

    const carol = await watch(workpieceId, 'carol');
    expect(await waitFor(() => carol.seen.has(222))).toBe(true);
    expect(carol.seen.get(222)).toEqual({ name: 'alice' });

    alice.socket.close();
    carol.socket.close();
  });

  it('lets the same person take their client over on a new connection', async () => {
    const workpieceId = await freshWorkpiece();
    const before = await watch(workpieceId, 'alice');
    before.socket.send(presence(333, 1, { name: 'alice', where: 'altes Netz' }));
    expect(await waitFor(() => before.seen.has(333))).toBe(true);

    const after = await watch(workpieceId, 'alice');
    after.socket.send(presence(333, 2, { name: 'alice', where: 'neues Netz' }));
    expect(await waitFor(() => after.seen.has(333))).toBe(true);

    before.socket.close();
    await before.closed;
    const bob = await watch(workpieceId, 'bob');

    expect(await waitFor(() => bob.seen.has(333))).toBe(true);
    expect(bob.seen.get(333)).toEqual({ name: 'alice', where: 'neues Netz' });
    expect(after.socket.readyState).toBe(WebSocket.OPEN);

    after.socket.close();
    bob.socket.close();
  });

  it('refuses a presence larger than the limit', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await watch(workpieceId, 'alice');

    alice.socket.send(presence(444, 1, { blob: 'x'.repeat(100_000) }));

    await expect(alice.closed).resolves.toBe(1009);
  });
});
