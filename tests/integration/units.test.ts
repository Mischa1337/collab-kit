import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import type { ObjectId } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
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
import { createWorkpiece, type UnitContainer } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createWorkpieceHub } from '../../src/realtime/hub.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_units_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

// Fixed client ids, so it is known who wins a key: the larger id.
const ALICE = 100;
const BOB = 200;
const CAROL = 300;

/** As the Copilot keeps its model today: one map, one key per cell. */
const CELLS: UnitContainer[] = [{ path: ['cells'] }];

/** The kinds of B and C, the events that hang on a unit. */
const CONFLICTS = new Set(['work-removed', 'work-replaced', 'work-lost']);

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;

/** A workpiece with these containers, in a room where alice, bob and carol may all write. */
async function freshWorkpiece(units: UnitContainer[] = CELLS): Promise<ObjectId> {
  const workpiece = await createWorkpiece(storage.db, {
    name: 'Modell',
    createdBy: 'alice',
    units,
  });
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

/** Opens the workpiece as this person with this doc. */
const open = async (workpieceId: ObjectId, actor: string, doc: Y.Doc) => {
  const client = await connectClient(
    `ws://127.0.0.1:${port}/ws/${workpieceId.toHexString()}`,
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

/** The events of one kind at the workpiece and all its units, oldest first. */
const ofKind = async (workpieceId: ObjectId, kind: string): Promise<EventRecord[]> =>
  (
    await readEvents(storage.db, { anchor: { kind: 'workpiece', id: workpieceId }, kind })
  ).toReversed();

/** Waits until this many events of one kind are written and gives them. */
const traced = async (workpieceId: ObjectId, kind: string, count: number) => {
  expect(await waitFor(async () => (await ofKind(workpieceId, kind)).length === count)).toBe(true);
  return ofKind(workpieceId, kind);
};

/** Sorted by unit, so the order the events were written in does not matter. */
const byUnit = (events: EventRecord[]) =>
  events.toSorted((a, b) => (a.anchor.unit ?? '').localeCompare(b.anchor.unit ?? ''));

/** Alice lays two cells in one change, so their clocks follow on one another; bob removes both. */
async function twoCellsRemoved(units: UnitContainer[] = CELLS): Promise<ObjectId> {
  const workpieceId = await freshWorkpiece(units);
  const alice = await open(workpieceId, 'alice', docOf(ALICE));
  alice.doc.transact(() => {
    alice.doc.getMap('cells').set('c1', 'eins');
    alice.doc.getMap('cells').set('c2', 'zwei');
  });
  await stored(workpieceId, 1);

  const bob = await open(workpieceId, 'bob', docOf(BOB));
  bob.doc.transact(() => {
    bob.doc.getMap('cells').delete('c1');
    bob.doc.getMap('cells').delete('c2');
  });
  await stored(workpieceId, 2);

  await Promise.all([alice.close(), bob.close()]);
  return workpieceId;
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const hub = createWorkpieceHub({ db: storage.db, logger: silent });
  const checkToken = createTokenCheck({ key: secret, algorithm: 'HS256' });
  server = createServer({
    logger: silent,
    api: createApi({
      db: storage.db,
      hub,
      checkToken,
      logger: silent,
      // Rights never change here, so there is nothing to ask again.
      recheckAccess: async () => {},
    }),
  });
  gateway = attachGateway({ server, db: storage.db, hub, checkToken, logger: silent });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await storage.db.dropDatabase();
  await storage.close();
});

describe('removed work at the unit it hit', () => {
  it('writes one event per cell, though their clocks follow on one another', async () => {
    const workpieceId = await twoCellsRemoved();

    const events = byUnit(await traced(workpieceId, 'work-removed', 2));
    expect(events.map((event) => [event.anchor, event.affects, event.detail])).toEqual([
      [
        { kind: 'workpiece', id: workpieceId, unit: 'c1' },
        ['alice'],
        { ranges: [{ client: ALICE, clock: 0, length: 1 }] },
      ],
      [
        { kind: 'workpiece', id: workpieceId, unit: 'c2' },
        ['alice'],
        { ranges: [{ client: ALICE, clock: 1, length: 1 }] },
      ],
    ]);
  });

  it('without units keeps one event on the workpiece, as before', async () => {
    const workpieceId = await twoCellsRemoved([]);

    const [event] = await traced(workpieceId, 'work-removed', 1);
    expect(event?.anchor).toEqual({ kind: 'workpiece', id: workpieceId });
    expect(event?.detail).toEqual({ ranges: [{ client: ALICE, clock: 0, length: 2 }] });
  });

  it('gives a character in the text of a nested cell to that cell, the innermost map', async () => {
    const workpieceId = await freshWorkpiece([{ path: ['model'] }, { path: ['model', 'cells'] }]);
    const alice = await open(workpieceId, 'alice', docOf(ALICE));
    alice.doc.transact(() => {
      const cells = new Y.Map<Y.Map<Y.Text>>();
      alice.doc.getMap('model').set('cells', cells);
      const cell = new Y.Map<Y.Text>();
      cells.set('c7', cell);
      cell.set('label', new Y.Text('Kunde'));
    });
    await stored(workpieceId, 1);

    const bob = await open(workpieceId, 'bob', docOf(BOB));
    const cells = bob.doc.getMap('model').get('cells') as Y.Map<Y.Map<Y.Text>>;
    cells.get('c7')?.get('label')?.delete(0, 2);
    await stored(workpieceId, 2);

    const [event] = await traced(workpieceId, 'work-removed', 1);
    expect(event).toMatchObject({ anchor: { unit: 'c7' }, affects: ['alice'] });

    await Promise.all([alice.close(), bob.close()]);
  });

  it('leaves what lies outside every container or under a blank key on the workpiece', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice', docOf(ALICE));
    alice.doc.transact(() => {
      alice.doc.getMap('cells').set('c1', 'eins');
      alice.doc.getMap('cells').set(' ', 'leer');
      alice.doc.getText('notes').insert(0, 'hallo');
    });
    await stored(workpieceId, 1);

    const bob = await open(workpieceId, 'bob', docOf(BOB));
    bob.doc.transact(() => {
      bob.doc.getMap('cells').delete('c1');
      bob.doc.getMap('cells').delete(' ');
      bob.doc.getText('notes').delete(0, 2);
    });
    await stored(workpieceId, 2);

    const events = byUnit(await traced(workpieceId, 'work-removed', 2));
    expect(events.map((event) => event.anchor)).toEqual([
      { kind: 'workpiece', id: workpieceId },
      { kind: 'workpiece', id: workpieceId, unit: 'c1' },
    ]);

    await Promise.all([alice.close(), bob.close()]);
  });
});

describe('lost work at the unit it hit', () => {
  it('hangs an overwritten value on its cell', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await open(workpieceId, 'carol', docOf(CAROL));
    carol.doc.getMap('cells').set('c1', 'C');
    await stored(workpieceId, 1);

    const alice = await away(workpieceId, 'alice', ALICE);
    const bob = await open(workpieceId, 'bob', docOf(BOB));
    bob.doc.getMap('cells').set('c1', 'B');
    await stored(workpieceId, 2);
    alice.getMap('cells').set('c1', 'A');
    const back = await open(workpieceId, 'alice', alice);
    await stored(workpieceId, 3);

    const [event] = await traced(workpieceId, 'work-lost', 1);
    expect(event).toMatchObject({
      anchor: { unit: 'c1' },
      affects: ['alice', 'bob'],
      detail: { cause: 'overwritten' },
    });

    await Promise.all([carol.close(), bob.close(), back.close()]);
  });

  it('hangs what was written into a removed cell on that cell, though it is gone', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await open(workpieceId, 'carol', docOf(CAROL));
    carol.doc.transact(() => {
      const cell = new Y.Map<string>();
      carol.doc.getMap('cells').set('c1', cell);
      cell.set('name', 'C');
    });
    await stored(workpieceId, 1);

    const bob = await away(workpieceId, 'bob', BOB);
    const alice = await open(workpieceId, 'alice', docOf(ALICE));
    alice.doc.getMap('cells').delete('c1');
    await stored(workpieceId, 2);
    (bob.getMap('cells').get('c1') as Y.Map<string>).set('name', 'B');
    const back = await open(workpieceId, 'bob', bob);
    await stored(workpieceId, 3);

    const [event] = await traced(workpieceId, 'work-lost', 1);
    expect(event).toMatchObject({
      anchor: { unit: 'c1' },
      affects: ['bob', 'alice'],
      detail: { cause: 'place-removed' },
    });

    await Promise.all([carol.close(), alice.close(), back.close()]);
  });
});

describe('asking for a unit', () => {
  it('finds the conflict of one cell, and none of them on the workpiece alone', async () => {
    const workpieceId = await twoCellsRemoved();
    await traced(workpieceId, 'work-removed', 2);

    const read = async (query: Record<string, string>) =>
      (
        await request(server)
          .get('/events')
          .query({ anchorKind: 'workpiece', anchorId: workpieceId.toHexString(), ...query })
          .set({ Authorization: `Bearer ${tokenOf('bob')}` })
      ).body as { kind: string; anchor: { unit?: string } }[];
    const conflictsIn = async (query: Record<string, string>) =>
      (await read(query)).filter((event) => CONFLICTS.has(event.kind));

    expect((await conflictsIn({ unit: 'c1' })).map((event) => event.anchor.unit)).toEqual(['c1']);
    expect(await conflictsIn({ scope: 'whole' })).toEqual([]);
    expect(await conflictsIn({})).toHaveLength(2);
  });
});
