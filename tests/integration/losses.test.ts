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
import { readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createWorkpieceHub, type WorkpieceHub } from '../../src/realtime/hub.ts';
import { deleterOf } from '../../src/realtime/persistence.ts';
import { createServer } from '../../src/routes/server.ts';
import { connectClient, waitFor, type TestClient } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_losses_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

// Fixed client ids, so it is known who wins a key: the larger id.
const ALICE = 100;
const BOB = 200;
const CAROL = 300;

let storage: Storage;
let hub: WorkpieceHub;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;

/** A workpiece in a room where alice, bob and carol may all write. */
async function freshWorkpiece(): Promise<ObjectId> {
  const workpiece = await createWorkpiece(storage.db, { name: 'Modell', createdBy: 'alice' });
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

/** A doc with this client id, to open with or to keep working on offline. */
const docOf = (clientID: number): Y.Doc => {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return doc;
};

/** Opens the workpiece as this person with this doc, asking for events if told to. */
const open = async (workpieceId: ObjectId, actor: string, doc: Y.Doc, events = false) => {
  const client = await connectClient(
    `ws://127.0.0.1:${port}/ws/${workpieceId.toHexString()}${events ? '?events=1' : ''}`,
    ['bearer', tokenOf(actor)],
    doc,
  );
  await client.synced;
  return client;
};

/** Opens and closes again at once: the doc holds the state and works on offline. */
const away = async (workpieceId: ObjectId, actor: string, clientID: number): Promise<Y.Doc> => {
  const client = await open(workpieceId, actor, docOf(clientID));
  await client.close();
  return client.doc;
};

/** Waits until this many changes of the workpiece are stored. */
const stored = async (workpieceId: ObjectId, count: number) =>
  expect(
    await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === count),
  ).toBe(true);

/** The id of the newest stored change. */
const newest = async (workpieceId: ObjectId) =>
  (await readUpdatesSince(storage.db, workpieceId)).at(-1)?._id;

/** Waits until all work queued for the workpiece is done, events included. */
const settled = (workpieceId: ObjectId) => hub.checkpoint(workpieceId, { createdBy: 'test' });

/** The work-lost events at the workpiece, oldest first. */
const losses = async (workpieceId: ObjectId): Promise<EventRecord[]> =>
  (
    await readEvents(storage.db, {
      anchor: { kind: 'workpiece', id: workpieceId },
      kind: 'work-lost',
    })
  ).toReversed();

/** Waits until this many work-lost events are written and gives them. */
const lost = async (workpieceId: ObjectId, count: number): Promise<EventRecord[]> => {
  expect(await waitFor(async () => (await losses(workpieceId)).length === count)).toBe(true);
  return losses(workpieceId);
};

/** Carol lays the ground everybody starts from: a cell with a name, a value x and a text. */
async function ground(workpieceId: ObjectId, events = false): Promise<TestClient> {
  const carol = await open(workpieceId, 'carol', docOf(CAROL), events);
  carol.doc.transact(() => {
    const cell = new Y.Map<string>();
    carol.doc.getMap('m').set('cell', cell);
    cell.set('name', 'C');
    carol.doc.getMap('m').set('x', 'C');
    carol.doc.getText('t').insert(0, 'hallo');
  });
  await stored(workpieceId, 1);
  return carol;
}

/** The cell carol made, as a doc holds it. */
const cellIn = (doc: Y.Doc) => doc.getMap('m').get('cell') as Y.Map<unknown>;

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

describe('a value overwritten at the same time', () => {
  /** Alice and bob both set x without knowing of each other; second says who sends last. */
  async function race(second: 'alice' | 'bob') {
    const workpieceId = await freshWorkpiece();
    const carol = await ground(workpieceId);
    const [first, firstId] = second === 'bob' ? ['alice', ALICE] : ['bob', BOB];
    const [last, lastId] = second === 'bob' ? ['bob', BOB] : ['alice', ALICE];

    const offline = await away(workpieceId, last, lastId);
    const online = await open(workpieceId, first, docOf(firstId));
    online.doc.getMap('m').set('x', first);
    await stored(workpieceId, 2);
    offline.getMap('m').set('x', last);
    const back = await open(workpieceId, last, offline);
    await stored(workpieceId, 3);

    const events = await lost(workpieceId, 1);
    await Promise.all([carol.close(), online.close(), back.close()]);
    return { events, at: await newest(workpieceId) };
  }

  it('tells alice she lost to bob when bob comes second', async () => {
    const { events, at } = await race('bob');

    expect(events[0]).toMatchObject({
      kind: 'work-lost',
      createdBy: 'bob',
      affects: ['alice', 'bob'],
      at,
      detail: {
        cause: 'overwritten',
        lost: [{ client: ALICE, clock: 0, length: 1 }],
        current: { client: BOB, clock: 0 },
      },
    });
  });

  it('tells it the same way when alice comes second', async () => {
    const { events } = await race('alice');

    expect(events[0]).toMatchObject({
      createdBy: 'bob',
      affects: ['alice', 'bob'],
      detail: { cause: 'overwritten', lost: [{ client: ALICE, clock: 0, length: 1 }] },
    });
  });
});

describe('a place removed while somebody wrote in it', () => {
  it('tells bob alice removed the cell when the deletion comes second', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await ground(workpieceId);
    const alice = await away(workpieceId, 'alice', ALICE);
    const bob = await open(workpieceId, 'bob', docOf(BOB));
    cellIn(bob.doc).set('name', 'B');
    await stored(workpieceId, 2);

    alice.getMap('m').delete('cell');
    const back = await open(workpieceId, 'alice', alice);
    await stored(workpieceId, 3);

    const [event] = await lost(workpieceId, 1);
    expect(event).toMatchObject({
      createdBy: 'alice',
      affects: ['bob', 'alice'],
      detail: {
        cause: 'place-removed',
        lost: [{ client: BOB, clock: 0, length: 1 }],
        removed: { client: CAROL, clock: 0 },
      },
    });

    await Promise.all([carol.close(), bob.close(), back.close()]);
  });

  it('finds who removed it when the change comes second, also after a reload', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await ground(workpieceId);
    const bob = await away(workpieceId, 'bob', BOB);
    const alice = await open(workpieceId, 'alice', docOf(ALICE));
    alice.doc.getMap('m').delete('cell');
    await stored(workpieceId, 2);

    // Everyone leaves, so the workpiece comes back from the fold.
    await Promise.all([carol.close(), alice.close()]);
    expect(await waitFor(() => gateway.countFor(workpieceId) === 0)).toBe(true);

    cellIn(bob).set('name', 'B');
    const back = await open(workpieceId, 'bob', bob);
    await stored(workpieceId, 3);

    const [event] = await lost(workpieceId, 1);
    expect(event).toMatchObject({
      createdBy: 'alice',
      affects: ['bob', 'alice'],
      detail: { cause: 'place-removed', removed: { client: CAROL, clock: 0 } },
    });

    await back.close();
  });

  it('counts what bob nested in the removed cell as lost there', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await ground(workpieceId);
    const bob = await away(workpieceId, 'bob', BOB);
    const alice = await open(workpieceId, 'alice', docOf(ALICE));
    alice.doc.getMap('m').delete('cell');
    await stored(workpieceId, 2);

    bob.transact(() => {
      const inner = new Y.Map<number>();
      cellIn(bob).set('detail', inner);
      inner.set('a', 1);
    });
    const back = await open(workpieceId, 'bob', bob);
    await stored(workpieceId, 3);

    const events = await lost(workpieceId, 1);
    expect(events[0]?.detail).toEqual({
      cause: 'place-removed',
      lost: [{ client: BOB, clock: 0, length: 2 }],
      removed: { client: CAROL, clock: 0 },
    });

    await Promise.all([carol.close(), alice.close(), back.close()]);
  });
});

describe('what loses nothing', () => {
  it('overwriting what one saw is a replacement, not a loss', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await ground(workpieceId);
    const alice = await open(workpieceId, 'alice', docOf(ALICE));
    alice.doc.getMap('m').set('x', 'A');
    await stored(workpieceId, 2);
    await settled(workpieceId);

    const replaced = await readEvents(storage.db, {
      anchor: { kind: 'workpiece', id: workpieceId },
      kind: 'work-replaced',
    });
    expect(replaced).toHaveLength(1);
    expect(await losses(workpieceId)).toEqual([]);

    await Promise.all([carol.close(), alice.close()]);
  });

  it('neither deleting against setting nor deleting text against typing', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await ground(workpieceId);
    const alice = await away(workpieceId, 'alice', ALICE);
    const bob = await open(workpieceId, 'bob', docOf(BOB));
    bob.doc.transact(() => {
      bob.doc.getMap('m').delete('x');
      bob.doc.getText('t').delete(0, 5);
    });
    await stored(workpieceId, 2);

    alice.transact(() => {
      alice.getMap('m').set('x', 'A');
      alice.getText('t').insert(2, 'XX');
    });
    const back = await open(workpieceId, 'alice', alice);
    await stored(workpieceId, 3);
    await settled(workpieceId);

    // Setting wins, and what was typed stays: nothing went, though an intention may have.
    expect(back.doc.getMap('m').get('x')).toBe('A');
    expect(back.doc.getText('t').toString()).toBe('XX');
    expect(await losses(workpieceId)).toEqual([]);

    await Promise.all([carol.close(), bob.close(), back.close()]);
  });

  it('neither two tabs of one person nor coming back with everything', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await ground(workpieceId);
    const later = await away(workpieceId, 'alice', ALICE + 1);
    const first = await open(workpieceId, 'alice', docOf(ALICE));
    first.doc.getMap('m').set('x', 'erster Tab');
    await stored(workpieceId, 2);

    later.getMap('m').set('x', 'zweiter Tab');
    const second = await open(workpieceId, 'alice', later);
    await stored(workpieceId, 3);

    // Everyone comes back once more with all they hold.
    await Promise.all([carol.close(), first.close(), second.close()]);
    expect(await waitFor(() => gateway.countFor(workpieceId) === 0)).toBe(true);
    const again = await Promise.all([
      open(workpieceId, 'carol', carol.doc),
      open(workpieceId, 'alice', first.doc),
      open(workpieceId, 'alice', second.doc),
    ]);
    // Gives what they sent on their way back the time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settled(workpieceId);

    expect(await losses(workpieceId)).toEqual([]);
    await Promise.all(again.map((client) => client.close()));
  });
});

describe('telling it at once', () => {
  it('sends work-lost to every connection that asked, involved or not, and to no other', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await ground(workpieceId, true);
    const bob = await away(workpieceId, 'bob', BOB);
    const alice = await open(workpieceId, 'alice', docOf(ALICE));
    alice.doc.getMap('m').set('x', 'A');
    await stored(workpieceId, 2);

    bob.getMap('m').set('x', 'B');
    const back = await open(workpieceId, 'bob', bob, true);
    await stored(workpieceId, 3);
    const [event] = await lost(workpieceId, 1);

    // As the routes give it: ids as hex.
    const told = {
      _id: event?._id.toHexString(),
      kind: 'work-lost',
      affects: ['alice', 'bob'],
      anchor: { kind: 'workpiece', id: workpieceId.toHexString() },
    };
    expect(await waitFor(() => carol.events.length === 1 && back.events.length === 1)).toBe(true);
    expect(carol.events[0]).toMatchObject(told);
    expect(back.events[0]).toMatchObject(told);
    expect(alice.events).toEqual([]);

    await Promise.all([carol.close(), alice.close(), back.close()]);
  });
});

describe('who deleted a piece', () => {
  it('keeps on each change whose pieces it deleted, and finds the one who did', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice', docOf(ALICE));
    alice.doc.getText('t').insert(0, 'abc');
    await stored(workpieceId, 1);
    const bob = await open(workpieceId, 'bob', docOf(BOB));
    bob.doc.getText('t').delete(1, 1);
    await stored(workpieceId, 2);

    const [written, deleting] = await readUpdatesSince(storage.db, workpieceId);
    expect(written?.deletes).toBeUndefined();
    expect(deleting?.deletes).toEqual([ALICE]);
    await expect(deleterOf(storage.db, workpieceId, { client: ALICE, clock: 1 })).resolves.toBe(
      'bob',
    );
    await expect(
      deleterOf(storage.db, workpieceId, { client: ALICE, clock: 0 }),
    ).resolves.toBeUndefined();

    await Promise.all([alice.close(), bob.close()]);
  });
});
