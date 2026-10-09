import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import type { ObjectId } from 'mongodb';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { readEvents, type EventRecord } from '../../src/db/collections/events.ts';
import { setGrant } from '../../src/db/collections/grants.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { appendUpdate, creatorsOf, readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createWorkpieceHub, type WorkpieceHub } from '../../src/realtime/hub.ts';
import { createServer } from '../../src/routes/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_removals_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;
let hub: WorkpieceHub;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;

/** A workpiece in a room where alice, bob and carol may all write. */
async function freshWorkpiece(): Promise<ObjectId> {
  const workpiece = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  const group = await createGroup(storage.db, {
    name: 'Teilnehmende',
    createdBy: 'alice',
    members: ['alice', 'bob', 'carol'],
  });
  await addToRoom(storage.db, room._id, {
    kind: 'workpiece',
    id: workpiece._id,
    addedBy: 'alice',
  });
  await setGrant(storage.db, {
    groupId: group._id,
    scope: { kind: 'room', id: room._id },
    rights: ['see', 'edit'],
    setBy: 'alice',
  });
  return workpiece._id;
}

const tokenOf = (actor: string) =>
  jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' });

/** Opens the workpiece as this person; pass an earlier doc to come back with all it holds. */
const open = async (workpieceId: ObjectId, actor: string, doc?: Y.Doc) => {
  const client = await connectClient(
    `ws://127.0.0.1:${port}/ws/${workpieceId.toHexString()}`,
    ['bearer', tokenOf(actor)],
    doc,
  );
  await client.synced;
  return client;
};

/** Waits until this many changes of the workpiece are stored. */
const stored = async (workpieceId: ObjectId, count: number) =>
  expect(
    await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === count),
  ).toBe(true);

/** Waits until all work queued for the workpiece is done, events included. */
const settled = (workpieceId: ObjectId) => hub.checkpoint(workpieceId, { createdBy: 'test' });

/** The events of removed and replaced work at the workpiece, oldest first. */
const removals = async (workpieceId: ObjectId): Promise<EventRecord[]> =>
  (await readEvents(storage.db, { anchor: { kind: 'workpiece', id: workpieceId } }))
    .filter((event) => event.kind === 'work-removed' || event.kind === 'work-replaced')
    .toReversed();

/** Waits until this many such events are written and gives them. */
const traced = async (workpieceId: ObjectId, count: number): Promise<EventRecord[]> => {
  expect(await waitFor(async () => (await removals(workpieceId)).length === count)).toBe(true);
  return removals(workpieceId);
};

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  server = createServer({ logger: silent });
  hub = createWorkpieceHub({ db: storage.db, logger: silent });
  gateway = attachGateway({
    server,
    db: storage.db,
    hub,
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

describe('work of another person that somebody removes', () => {
  it('tells alice that bob removed part of her text, at his change', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    alice.doc.getText('t').insert(0, 'von alice');
    await stored(workpieceId, 1);

    const bob = await open(workpieceId, 'bob');
    bob.doc.getText('t').delete(0, 4);
    await stored(workpieceId, 2);

    const [event] = await traced(workpieceId, 1);
    const change = (await readUpdatesSince(storage.db, workpieceId)).at(-1);
    expect(event).toMatchObject({
      kind: 'work-removed',
      createdBy: 'bob',
      affects: ['alice'],
      at: change?._id,
      detail: { ranges: [{ client: alice.doc.clientID, clock: 0, length: 4 }] },
    });

    await Promise.all([alice.close(), bob.close()]);
  });

  it('calls a value that another took the place of replaced, and nothing else', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    alice.doc.getMap('m').set('x', 'alt');
    await stored(workpieceId, 1);

    const bob = await open(workpieceId, 'bob');
    bob.doc.getMap('m').set('x', 'neu');
    await stored(workpieceId, 2);
    await settled(workpieceId);

    const events = await traced(workpieceId, 1);
    expect(events.map((event) => event.kind)).toEqual(['work-replaced']);
    expect(events[0]?.affects).toEqual(['alice']);

    await Promise.all([alice.close(), bob.close()]);
  });

  it('calls a nested map removed together with what alice wrote in it', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    alice.doc.transact(() => {
      const cell = new Y.Map<string>();
      alice.doc.getMap('m').set('cell', cell);
      cell.set('name', 'Kunde');
    });
    await stored(workpieceId, 1);

    const bob = await open(workpieceId, 'bob');
    bob.doc.getMap('m').delete('cell');
    await stored(workpieceId, 2);
    await settled(workpieceId);

    const events = await traced(workpieceId, 1);
    expect(events[0]).toMatchObject({
      kind: 'work-removed',
      affects: ['alice'],
      detail: { ranges: [{ client: alice.doc.clientID, clock: 0, length: 2 }] },
    });

    await Promise.all([alice.close(), bob.close()]);
  });

  it('writes one event per person whose work went', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    alice.doc.getText('t').insert(0, 'A');
    await stored(workpieceId, 1);
    const carol = await open(workpieceId, 'carol');
    carol.doc.getText('t').insert(1, 'C');
    await stored(workpieceId, 2);

    const bob = await open(workpieceId, 'bob');
    bob.doc.getText('t').delete(0, 2);
    await stored(workpieceId, 3);

    const events = await traced(workpieceId, 2);
    expect(events.map((event) => event.affects?.[0]).toSorted()).toEqual(['alice', 'carol']);
    expect(events.every((event) => event.createdBy === 'bob')).toBe(true);

    await Promise.all([alice.close(), carol.close(), bob.close()]);
  });

  it('counts only what bob knew of a text that grew while he was away', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    const cell = new Y.Map<Y.Text>();
    alice.doc.getMap('m').set('cell', cell);
    const text = new Y.Text();
    cell.set('t', text);
    text.insert(0, 'ab');
    await stored(workpieceId, 3);

    // Bob takes the state along and goes offline.
    const away = await open(workpieceId, 'bob');
    await away.close();

    // Alice writes on; the service keeps ab and cd as one piece.
    text.insert(2, 'cd');
    await stored(workpieceId, 4);

    // Offline, bob deletes the cell with what he knows of it, then comes back.
    away.doc.getMap('m').delete('cell');
    const back = await open(workpieceId, 'bob', away.doc);
    await stored(workpieceId, 5);

    // Cell, text and ab; cd was not in front of him.
    const [event] = await traced(workpieceId, 1);
    expect(event).toMatchObject({
      kind: 'work-removed',
      affects: ['alice'],
      detail: { ranges: [{ client: alice.doc.clientID, clock: 0, length: 4 }] },
    });

    await Promise.all([alice.close(), back.close()]);
  });
});

describe('what tells of nothing', () => {
  it('leaves own work alone, from an earlier session too', async () => {
    const workpieceId = await freshWorkpiece();
    const before = await open(workpieceId, 'alice');
    before.doc.getText('t').insert(0, 'entwurf');
    await stored(workpieceId, 1);
    await before.close();

    const later = await open(workpieceId, 'alice');
    later.doc.getText('t').delete(0, 3);
    await stored(workpieceId, 2);
    await settled(workpieceId);

    expect(await removals(workpieceId)).toEqual([]);
    await later.close();
  });

  it('stays quiet when somebody comes back with everything, and after a reload', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    alice.doc.getText('t').insert(0, 'von alice');
    await stored(workpieceId, 1);
    const bob = await open(workpieceId, 'bob');
    bob.doc.getText('t').delete(0, 4);
    await stored(workpieceId, 2);
    await traced(workpieceId, 1);

    // Everyone leaves, so the next one in loads the workpiece from the database.
    await Promise.all([alice.close(), bob.close()]);
    expect(await waitFor(() => gateway.countFor(workpieceId) === 0)).toBe(true);

    // Both come back with their full delete sets.
    const aliceBack = await open(workpieceId, 'alice', alice.doc);
    const bobBack = await open(workpieceId, 'bob', bob.doc);
    // Gives what they sent on their way back the time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settled(workpieceId);

    expect(await removals(workpieceId)).toHaveLength(1);
    await Promise.all([aliceBack.close(), bobBack.close()]);
  });
});

describe('whose pieces they are', () => {
  it('keeps on each change the clients that brought new pieces', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    alice.doc.getText('t').insert(0, 'x');
    await stored(workpieceId, 1);

    const [change] = await readUpdatesSince(storage.db, workpieceId);
    expect(change?.clients).toEqual([alice.doc.clientID]);
    await alice.close();
  });

  it('names the author of the first change that brought a client', async () => {
    const workpieceId = await freshWorkpiece();
    const change = (clients: number[], createdBy: string) =>
      appendUpdate(storage.db, { workpieceId, bytes: new Uint8Array([0]), clients, createdBy });
    await change([7], 'alice');
    await change([7, 8], 'bob');

    const creators = await creatorsOf(storage.db, workpieceId, [7, 8, 9]);
    expect([...creators].toSorted()).toEqual([
      [7, 'alice'],
      [8, 'bob'],
    ]);
  });
});
