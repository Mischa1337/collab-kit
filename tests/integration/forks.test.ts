import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { latestEvent, readEvents, type EventRecord } from '../../src/db/collections/events.ts';
import { setGrant } from '../../src/db/collections/grants.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { appendUpdate, readUpdatesSince } from '../../src/db/collections/updates.ts';
import {
  createWorkpiece,
  findWorkpieceWithFold,
  type UnitContainer,
} from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import type { Right } from '../../src/model/right.ts';
import {
  attachGateway,
  createWorkpieceHub,
  readStateAt,
  type Gateway,
  type Connection,
} from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_forks_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });
/** How long removals here wait for more before they are written. */
const PAUSE = 200;

// Fixed client ids, so it is known who wins a key: the larger id.
const ALICE = 100;
const BOB = 200;
const CAROL = 300;

/** As the Copilot keeps its model today: one map, one key per cell. */
const CELLS: UnitContainer[] = [{ path: ['cells'] }];

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;

const tokenOf = (actor: string) =>
  jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' });
const as = (actor: string) => ({ Authorization: `Bearer ${tokenOf(actor)}` });

/** A room where these people hold these rights, and the group they hold them through. */
async function teamWith(members: string[], rights: [Right, ...Right[]]) {
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  const group = await createGroup(storage.db, { name: 'Team', createdBy: 'alice', members });
  await setGrant(storage.db, {
    groupId: group._id,
    scope: { kind: 'room', id: room._id },
    rights,
    setBy: 'alice',
  });
  return { roomId: room._id, groupId: group._id };
}

/** A room where these people hold these rights. */
async function roomFor(members: string[], rights: [Right, ...Right[]]): Promise<ObjectId> {
  return (await teamWith(members, rights)).roomId;
}

/** The room of the team: alice, bob and carol see, write and may put workpieces in it. */
const team = () => roomFor(['alice', 'bob', 'carol'], ['see', 'edit', 'manage']);

/** A workpiece of the Copilot kind in that room. */
async function workpieceIn(roomId: ObjectId): Promise<ObjectId> {
  const workpiece = await createWorkpiece(storage.db, {
    name: 'Modell',
    createdBy: 'alice',
    contract: { kind: 'modell' },
    units: CELLS,
  });
  await addToRoom(storage.db, roomId, { workpieceId: workpiece._id, addedBy: 'alice' });
  return workpiece._id;
}

/** A doc with this client id, or a random one. */
const docOf = (clientID?: number): Y.Doc => {
  const doc = new Y.Doc();
  if (clientID !== undefined) {
    doc.clientID = clientID;
  }
  return doc;
};

/** Opens the workpiece as this person, asking for events if told to. */
const open = async (workpieceId: ObjectId, actor: string, doc = docOf(), events = false) => {
  const client = await connectClient(
    `ws://127.0.0.1:${port}/ws/${workpieceId.toHexString()}${events ? '?events=1' : ''}`,
    ['bearer', tokenOf(actor)],
    doc,
  );
  await client.synced;
  return client;
};

/** The stored changes of a workpiece, oldest first. */
const changesOf = (workpieceId: ObjectId) => readUpdatesSince(storage.db, workpieceId);

/** Waits until this many changes of the workpiece are stored. */
const stored = async (workpieceId: ObjectId, count: number) =>
  expect(await waitFor(async () => (await changesOf(workpieceId)).length === count)).toBe(true);

/** Waits until everybody has left the workpiece. */
const closed = async (workpieceId: ObjectId) =>
  expect(await waitFor(() => gateway.countFor(workpieceId) === 0)).toBe(true);

/** The stored state of a workpiece as a doc to read from. */
async function stateOf(workpieceId: ObjectId): Promise<Y.Doc> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await readStateAt(storage.db, workpieceId)).state);
  return doc;
}

/** The text t of the stored state. */
const textOf = async (workpieceId: ObjectId) =>
  (await stateOf(workpieceId)).getText('t').toString();

/** Forks as this person. */
const fork = (actor: string, sourceId: ObjectId, body: object) =>
  request(server).post(`/workpieces/${sourceId.toHexString()}/forks`).set(as(actor)).send(body);

/** Forks into the room and gives the id of the fork. */
async function forkInto(actor: string, sourceId: ObjectId, roomId: ObjectId): Promise<ObjectId> {
  const forked = await fork(actor, sourceId, {
    name: 'Eigene Kopie',
    roomId: roomId.toHexString(),
  });
  expect(forked.status).toBe(201);
  return new ObjectId(forked.body._id as string);
}

/** Forks apart from every room and gives the id of the fork. */
async function forkApart(actor: string, sourceId: ObjectId): Promise<ObjectId> {
  const forked = await fork(actor, sourceId, { name: 'Eigene Kopie' });
  expect(forked.status).toBe(201);
  return new ObjectId(forked.body._id as string);
}

/** The rights this person holds at the workpiece, as CK tells them. */
const rightsOf = async (actor: string, workpieceId: ObjectId) =>
  (
    await request(server)
      .get('/me/rights')
      .query({ kind: 'workpiece', id: workpieceId.toHexString() })
      .set(as(actor))
  ).body as Right[];

/** Merges as this person. */
const merge = (actor: string, targetId: ObjectId, body: object) =>
  request(server).post(`/workpieces/${targetId.toHexString()}/merges`).set(as(actor)).send(body);

/** Merges from a workpiece and gives the answer, which must be workpiece-merged. */
async function mergeFrom(actor: string, targetId: ObjectId, from: ObjectId) {
  const merged = await merge(actor, targetId, { from: from.toHexString() });
  expect(merged.status).toBe(201);
  return merged.body as {
    _id: string;
    at?: string;
    affects?: string[];
    detail: { from: string; upTo?: string; count: number };
  };
}

/** The events of one kind at a workpiece and all its units, oldest first. */
const ofKind = async (workpieceId: ObjectId, kind: string): Promise<EventRecord[]> =>
  (
    await readEvents(storage.db, { anchor: { kind: 'workpiece', id: workpieceId }, kind })
  ).toReversed();

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const hub = createWorkpieceHub({ db: storage.db, logger: silent, bundlePause: PAUSE });
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

describe('forking', () => {
  it('takes the state of then, each change under its author, and tells only the fork', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const alice = await open(groupWork, 'alice');
    alice.doc.getText('t').insert(0, 'a');
    await stored(groupWork, 1);
    const bob = await open(groupWork, 'bob');
    bob.doc.getText('t').insert(1, 'b');
    await stored(groupWork, 2);
    alice.doc.getText('t').insert(2, 'c');
    await stored(groupWork, 3);
    const point = (await changesOf(groupWork))[1]!._id;

    const forked = await fork('alice', groupWork, {
      name: 'Eigene Kopie',
      at: point.toHexString(),
      roomId: roomId.toHexString(),
      reason: 'allein weiter',
    });

    expect(forked.status).toBe(201);
    expect(forked.body).toMatchObject({
      name: 'Eigene Kopie',
      createdBy: 'alice',
      contract: { kind: 'modell' },
      units: CELLS,
      forkOf: { id: groupWork.toHexString(), at: point.toHexString() },
    });
    const own = new ObjectId(forked.body._id as string);
    expect(await textOf(own)).toBe('ab');

    const history = await request(server)
      .get(`/workpieces/${own.toHexString()}/updates`)
      .set(as('bob'));
    expect(history.body.map((change: { createdBy: string }) => change.createdBy)).toEqual([
      'alice',
      'bob',
    ]);

    const [event] = await ofKind(own, 'workpiece-forked');
    expect(event).toMatchObject({
      createdBy: 'alice',
      at: (await changesOf(own)).at(-1)?._id,
      reason: 'allein weiter',
      detail: { from: groupWork, fromAt: point },
    });
    expect(await ofKind(groupWork, 'workpiece-forked')).toEqual([]);

    await Promise.all([alice.close(), bob.close()]);
  });

  it('without a point takes what an open source has stored by now', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const alice = await open(groupWork, 'alice');
    alice.doc.getText('t').insert(0, 'offen');
    await stored(groupWork, 1);

    const forked = await fork('alice', groupWork, {
      name: 'Eigene Kopie',
      roomId: roomId.toHexString(),
    });

    expect(forked.body.forkOf.at).toBe((await changesOf(groupWork))[0]?._id.toHexString());
    expect(await textOf(new ObjectId(forked.body._id as string))).toBe('offen');
    await alice.close();
  });

  it('tells alice when bob removes in the fork what she did before it', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const alice = await open(groupWork, 'alice');
    alice.doc.getMap('cells').set('c1', 'A');
    await stored(groupWork, 1);
    await alice.close();

    const own = await forkInto('bob', groupWork, roomId);
    const bob = await open(own, 'bob');
    bob.doc.getMap('cells').delete('c1');
    await stored(own, 2);

    expect(await waitFor(async () => (await ofKind(own, 'work-removed')).length === 1)).toBe(true);
    expect((await ofKind(own, 'work-removed'))[0]).toMatchObject({
      createdBy: 'bob',
      affects: ['alice'],
      anchor: { unit: 'c1' },
    });
    await bob.close();
  });
});

describe('merging', () => {
  it('brings each change under its author, names whose work came, and shows it live', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const alice = await open(groupWork, 'alice');
    alice.doc.getText('t').insert(0, 'hallo');
    await stored(groupWork, 1);

    const own = await forkInto('alice', groupWork, roomId);
    const bob = await open(own, 'bob');
    bob.doc.getText('t').insert(5, ' bob');
    await stored(own, 2);
    const carol = await open(own, 'carol');
    carol.doc.getText('t').insert(9, ' carol');
    await stored(own, 3);

    const merged = await merge('alice', groupWork, {
      from: own.toHexString(),
      reason: 'in die Gruppe',
    });

    expect(merged.status).toBe(201);
    expect(merged.body).toMatchObject({
      kind: 'workpiece-merged',
      createdBy: 'alice',
      reason: 'in die Gruppe',
      affects: ['bob', 'carol'],
      at: (await changesOf(groupWork)).at(-1)?._id.toHexString(),
      detail: {
        from: own.toHexString(),
        upTo: (await changesOf(own)).at(-1)?._id.toHexString(),
        count: 2,
      },
    });
    expect((await changesOf(groupWork)).map((change) => change.createdBy)).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
    expect(await waitFor(() => alice.doc.getText('t').toString() === 'hallo bob carol')).toBe(true);

    await Promise.all([alice.close(), bob.close(), carol.close()]);
  });

  it('tells what comes in at the unit hit, under the merge, at once, not as activity', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const bob = await open(groupWork, 'bob', docOf(BOB));
    bob.doc.getMap('cells').set('c3', 'B');
    await stored(groupWork, 1);
    const carol = await open(groupWork, 'carol', docOf(CAROL), true);
    carol.doc.transact(() => {
      carol.doc.getMap('cells').set('c9', 'C');
      const cell = new Y.Map<string>();
      carol.doc.getMap('cells').set('c5', cell);
      cell.set('name', 'C');
    });
    await stored(groupWork, 2);

    // Alice works in her fork while carol goes on in the group.
    const own = await forkInto('alice', groupWork, roomId);
    const alice = await open(own, 'alice', docOf(ALICE));
    alice.doc.transact(() => {
      alice.doc.getMap('cells').delete('c3');
      alice.doc.getMap('cells').set('c9', 'A');
      (alice.doc.getMap('cells').get('c5') as Y.Map<string>).set('name', 'A');
    });
    await stored(own, 3);
    carol.doc.transact(() => {
      carol.doc.getMap('cells').set('c9', 'C2');
      carol.doc.getMap('cells').delete('c5');
    });
    await stored(groupWork, 3);
    const before = (await changesOf(groupWork)).at(-1)?._id;

    const merged = await mergeFrom('alice', groupWork, own);

    const at = new ObjectId(merged.at);
    const mark = { merge: new ObjectId(merged._id) };
    expect(await ofKind(groupWork, 'work-removed')).toMatchObject([
      {
        createdBy: 'alice',
        affects: ['bob'],
        anchor: { unit: 'c3' },
        at,
        detail: { ...mark, since: before },
      },
    ]);
    const lost = await ofKind(groupWork, 'work-lost');
    expect(
      lost.map((event) => [event.anchor.unit, event.detail?.['cause'], event.affects]),
    ).toEqual(
      expect.arrayContaining([
        ['c9', 'overwritten', ['alice', 'carol']],
        ['c5', 'place-removed', ['alice', 'carol']],
      ]),
    );
    expect(lost.every((event) => event.detail?.['merge']?.equals(mark.merge))).toBe(true);
    expect(await waitFor(() => carol.events.length === 2)).toBe(true);

    const activity = await request(server)
      .get(`/workpieces/${groupWork.toHexString()}/activity`)
      .set(as('alice'));
    expect(activity.body).toContainEqual(
      expect.objectContaining({ actorId: 'alice', kind: 'workpiece-merged' }),
    );

    await Promise.all([bob.close(), carol.close(), alice.close()]);
  });

  it('keeps a bundle still gathering live apart from what a merge finds', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const alice = await open(groupWork, 'alice');
    alice.doc.getText('t').insert(0, 'abcd');
    await stored(groupWork, 1);

    // Bob deletes a of alice in his fork ...
    const own = await forkInto('bob', groupWork, roomId);
    const inFork = await open(own, 'bob');
    inFork.doc.getText('t').delete(0, 1);
    await stored(own, 2);

    // ... and d of alice live in the group, then merges before his pause is over.
    const bob = await open(groupWork, 'bob');
    bob.doc.getText('t').delete(3, 1);
    await stored(groupWork, 2);
    const merged = await mergeFrom('bob', groupWork, own);

    expect(await waitFor(async () => (await ofKind(groupWork, 'work-removed')).length === 2)).toBe(
      true,
    );
    const events = await ofKind(groupWork, 'work-removed');
    const live = events.find((event) => event.detail?.['merge'] === undefined);
    const replayed = events.find((event) => event.detail?.['merge'] !== undefined);
    expect(live?.detail?.['ranges']).toEqual([{ client: alice.doc.clientID, clock: 3, length: 1 }]);
    expect(replayed).toMatchObject({
      detail: {
        merge: new ObjectId(merged._id),
        ranges: [{ client: alice.doc.clientID, clock: 0, length: 1 }],
      },
    });

    await Promise.all([alice.close(), inFork.close(), bob.close()]);
  });

  it('tells the same way when the work of the group comes into the fork', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const bob = await open(groupWork, 'bob', docOf(BOB));
    bob.doc.getMap('cells').set('c3', 'B');
    await stored(groupWork, 1);
    const carol = await open(groupWork, 'carol', docOf(CAROL));
    carol.doc.getMap('cells').set('c9', 'C');
    await stored(groupWork, 2);

    const own = await forkInto('alice', groupWork, roomId);
    const alice = await open(own, 'alice', docOf(ALICE));
    alice.doc.getMap('cells').set('c9', 'A');
    await stored(own, 3);
    carol.doc.transact(() => {
      carol.doc.getMap('cells').delete('c3');
      carol.doc.getMap('cells').set('c9', 'C2');
    });
    await stored(groupWork, 3);

    const merged = await mergeFrom('alice', own, groupWork);

    expect(merged).toMatchObject({
      affects: ['carol'],
      detail: { upTo: (await changesOf(groupWork)).at(-1)?._id.toHexString(), count: 1 },
    });
    expect(await ofKind(own, 'work-removed')).toMatchObject([
      { createdBy: 'carol', affects: ['bob'], anchor: { unit: 'c3' } },
    ]);
    expect(await ofKind(own, 'work-lost')).toMatchObject([
      {
        createdBy: 'carol',
        affects: ['alice', 'carol'],
        anchor: { unit: 'c9' },
        detail: { cause: 'overwritten' },
      },
    ]);

    await Promise.all([bob.close(), carol.close(), alice.close()]);
  });

  it('brings only what is new next time, then nothing, nothing back the other way', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const alice = await open(groupWork, 'alice');
    alice.doc.getText('t').insert(0, 'a');
    await stored(groupWork, 1);
    await alice.close();

    const own = await forkInto('alice', groupWork, roomId);
    const bob = await open(own, 'bob');
    bob.doc.getText('t').insert(1, 'b');
    await stored(own, 2);
    const first = await mergeFrom('alice', groupWork, own);
    bob.doc.getText('t').insert(2, 'c');
    await stored(own, 3);
    const second = await mergeFrom('alice', groupWork, own);
    const third = await mergeFrom('alice', groupWork, own);
    const back = await mergeFrom('alice', own, groupWork);

    const newest = (await changesOf(own)).at(-1)?._id.toHexString();
    expect(first.detail.count).toBe(1);
    expect(second.detail).toMatchObject({ count: 1, upTo: newest });
    expect(second.affects).toEqual(['bob']);
    expect(third.detail).toMatchObject({ count: 0, upTo: newest });
    expect(third.affects).toBeUndefined();
    expect(back.detail.count).toBe(0);
    expect(await textOf(groupWork)).toBe('abc');
    expect(await changesOf(groupWork)).toHaveLength(3);
    expect(await changesOf(own)).toHaveLength(3);

    await bob.close();
  });

  it('loads a closed target and lets go of it again, folded', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const own = await forkInto('alice', groupWork, roomId);
    const bob = await open(own, 'bob');
    bob.doc.getText('t').insert(0, 'allein');
    await stored(own, 1);
    await bob.close();

    const merged = await mergeFrom('alice', groupWork, own);

    expect(gateway.countFor(groupWork)).toBe(0);
    const folded = await findWorkpieceWithFold(storage.db, groupWork);
    expect(folded?.fold?.upToUpdateId.toHexString()).toBe(merged.at);
    expect(await textOf(groupWork)).toBe('allein');
  });

  it('loses nothing when the last one leaves the target while the merge runs', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const own = await forkInto('alice', groupWork, roomId);
    const bob = await open(own, 'bob');
    for (let index = 0; index < 200; index += 1) {
      bob.doc.getText('t').insert(index, 'x');
    }
    await stored(own, 200);
    await bob.close();

    // Sent at once, supertest would wait for the await; alice leaves once the merge stores.
    const alice = await open(groupWork, 'alice');
    const merging = merge('alice', groupWork, { from: own.toHexString() }).then((answer) => answer);
    expect(await waitFor(async () => (await changesOf(groupWork)).length > 0)).toBe(true);
    await alice.close();
    const merged = await merging;

    expect(merged.body.detail.count).toBe(200);
    await closed(groupWork);
    expect(await textOf(groupWork)).toBe('x'.repeat(200));
    expect(
      await waitFor(
        async () =>
          (await findWorkpieceWithFold(storage.db, groupWork))?.fold?.upToUpdateId.toHexString() ===
          merged.body.at,
      ),
    ).toBe(true);
  });

  it('loses nothing when the last one leaves just as a merge begins', async () => {
    // Each moment right after the leaving goes on, as a merge may begin at any of them.
    /* eslint-disable no-await-in-loop */
    for (let ticks = 0; ticks < 20; ticks += 1) {
      // Noting the name of whoever leaves is held back, so the test knows when it goes on.
      let holdBack = false;
      let goOn: (() => void) | undefined;
      const hub = createWorkpieceHub({
        db: storage.db,
        logger: silent,
        noteActor: () =>
          holdBack
            ? new Promise<void>((resolve) => {
                goOn = resolve;
              })
            : Promise.resolve(),
      });
      const target = (await createWorkpiece(storage.db, { name: 'Gruppe', createdBy: 'alice' }))
        ._id;
      const source = (await createWorkpiece(storage.db, { name: 'Allein', createdBy: 'bob' }))._id;
      const written = new Y.Doc();
      written.getText('t').insert(0, 'allein');
      await appendUpdate(storage.db, {
        workpieceId: source,
        bytes: Y.encodeStateAsUpdate(written),
        clients: [written.clientID],
        createdBy: 'bob',
      });
      const rows = await readUpdatesSince(storage.db, source);

      const alice: Connection = {
        actor: { actorId: 'alice' },
        wantsEvents: false,
        send: () => {},
        close: () => {},
      };
      await hub.join(target, alice);
      holdBack = true;
      const leaving = hub.leave(target, alice);
      expect(
        await waitFor(
          async () =>
            goOn !== undefined &&
            (await latestEvent(storage.db, {
              anchor: { kind: 'workpiece', id: target },
              kind: 'left',
            })) !== null,
        ),
      ).toBe(true);

      // Lets the leaving go on, and begins the merge so many ticks later.
      goOn?.();
      let later = Promise.resolve();
      for (let tick = 0; tick < ticks; tick += 1) {
        later = later.then(() => {});
      }
      const merged = await later.then(() =>
        hub.merge(target, {
          from: source,
          rows,
          writers: new Map(),
          upTo: rows[0]!._id,
          createdBy: 'alice',
        }),
      );
      await leaving;

      expect(merged.detail?.['count']).toBe(1);
      expect(await readUpdatesSince(storage.db, target)).toHaveLength(1);
      await hub.close();
    }
    /* eslint-enable no-await-in-loop */
  });

  it('unites two states without a shared past', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const elsewhere = await workpieceIn(roomId);
    const alice = await open(groupWork, 'alice');
    alice.doc.getText('t').insert(0, 'G');
    await stored(groupWork, 1);
    const bob = await open(elsewhere, 'bob');
    bob.doc.getText('t').insert(0, 'W');
    await stored(elsewhere, 1);

    const merged = await mergeFrom('alice', groupWork, elsewhere);

    expect(merged.detail.count).toBe(1);
    expect((await textOf(groupWork)).split('').toSorted()).toEqual(['G', 'W']);
    await Promise.all([alice.close(), bob.close()]);
  });
});

describe('an own fork', () => {
  it('gives whoever forked what they hold at the source, and nobody else anything', async () => {
    const roomId = await roomFor(['alice', 'bob'], ['see', 'edit']);
    const own = await forkApart('alice', await workpieceIn(roomId));
    const listed = async (actor: string) =>
      ((await request(server).get('/workpieces').set(as(actor))).body as { _id: string }[]).map(
        (entry) => entry._id,
      );
    const described = (actor: string) =>
      request(server).get(`/workpieces/${own.toHexString()}`).set(as(actor));

    expect(await rightsOf('alice', own)).toEqual(['see', 'edit']);
    expect(await listed('alice')).toContain(own.toHexString());
    expect((await described('alice')).status).toBe(200);
    // bob sees the source through the same room, but the fork is not his.
    expect(await rightsOf('bob', own)).toEqual([]);
    expect(await listed('bob')).not.toContain(own.toHexString());
    expect((await described('bob')).status).toBe(404);
  });

  it('follows the source, so edit taken there is gone at the fork, on the socket too', async () => {
    const { roomId, groupId } = await teamWith(['alice'], ['see', 'edit']);
    const own = await forkApart('alice', await workpieceIn(roomId));
    const alice = await open(own, 'alice');
    alice.doc.getText('t').insert(0, 'eigen');
    await stored(own, 1);

    await setGrant(storage.db, {
      groupId,
      scope: { kind: 'room', id: roomId },
      rights: ['see'],
      setBy: 'alice',
    });
    // The routes here never ask again, so the gateway is told directly.
    await gateway.recheck();

    await expect(alice.closed).resolves.toBe(4409);
    expect(await rightsOf('alice', own)).toEqual(['see']);
  });

  it('reaches through a fork of the own fork, but lends nothing to someone else', async () => {
    const roomId = await roomFor(['alice', 'bob'], ['see', 'edit']);
    const own = await forkApart('alice', await workpieceIn(roomId));
    const ownOfOwn = await forkApart('alice', own);
    const readers = await createGroup(storage.db, {
      name: 'Lesende',
      createdBy: 'alice',
      members: ['bob'],
    });
    await setGrant(storage.db, {
      groupId: readers._id,
      scope: { kind: 'workpiece', id: own },
      rights: ['see'],
      setBy: 'alice',
    });

    expect(await rightsOf('alice', ownOfOwn)).toEqual(['see', 'edit']);
    // bob writes at the source, but at the fork of alice he holds only the grant there.
    expect(await rightsOf('bob', own)).toEqual(['see']);
    expect((await fork('bob', own, { name: 'Kopie' })).status).toBe(403);
  });

  it('gives a task there to no group without a grant of its own at the fork', async () => {
    const { roomId, groupId } = await teamWith(['alice', 'bob'], ['see', 'edit', 'plan']);
    const own = await forkApart('alice', await workpieceIn(roomId));
    const plan = (assignee: object) =>
      request(server)
        .post('/tasks')
        .set(as('alice'))
        .send({
          kind: 'task',
          title: 'Prüfen',
          state: 'open',
          anchor: { kind: 'workpiece', id: own.toHexString() },
          assignees: [assignee],
        });

    expect((await plan({ kind: 'group', id: groupId.toHexString() })).status).toBe(409);
    expect((await plan({ kind: 'actor', id: 'alice' })).status).toBe(201);
  });
});

describe('who may fork and merge', () => {
  it('forks with edit where the fork will lie, as manage there is not enough', async () => {
    const groupWork = await workpieceIn(await team());
    const writing = await roomFor(['grace'], ['see', 'edit']);
    const managing = await roomFor(['heidi'], ['see', 'manage']);
    await addToRoom(storage.db, writing, { workpieceId: groupWork, addedBy: 'alice' });
    await addToRoom(storage.db, managing, { workpieceId: groupWork, addedBy: 'alice' });
    const apart = { name: 'Kopie' };

    expect((await fork('grace', groupWork, apart)).status).toBe(201);
    expect(
      (await fork('grace', groupWork, { ...apart, roomId: writing.toHexString() })).status,
    ).toBe(201);
    expect((await fork('heidi', groupWork, apart)).status).toBe(403);
    expect(
      (await fork('heidi', groupWork, { ...apart, roomId: managing.toHexString() })).status,
    ).toBe(403);
  });

  it('forks only what one sees, into a room one may edit, at a change of the source', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const onlySeeing = await roomFor(['erin'], ['see']);
    await addToRoom(storage.db, onlySeeing, { workpieceId: groupWork, addedBy: 'alice' });
    const other = await workpieceIn(roomId);
    const alice = await open(other, 'alice');
    alice.doc.getText('t').insert(0, 'x');
    await stored(other, 1);
    await alice.close();
    const foreign = (await changesOf(other))[0]!._id.toHexString();
    const into = { name: 'Kopie', roomId: roomId.toHexString() };

    expect((await fork('dave', groupWork, into)).status).toBe(404);
    expect((await fork('erin', groupWork, into)).status).toBe(404);
    expect(
      (await fork('erin', groupWork, { name: 'Kopie', roomId: onlySeeing.toHexString() })).status,
    ).toBe(403);
    expect((await fork('erin', groupWork, { name: 'Kopie' })).status).toBe(403);
    expect((await fork('alice', groupWork, { ...into, at: foreign })).status).toBe(404);
    expect((await fork('alice', groupWork, { ...into, at: 'kaputt' })).status).toBe(400);
    expect((await fork('alice', groupWork, { roomId: roomId.toHexString() })).status).toBe(400);
  });

  it('merges only into what one may change, from what one sees, never into itself', async () => {
    const roomId = await team();
    const groupWork = await workpieceIn(roomId);
    const onlySeeing = await roomFor(['erin'], ['see']);
    await addToRoom(storage.db, onlySeeing, { workpieceId: groupWork, addedBy: 'alice' });
    const hidden = await workpieceIn(await roomFor(['frank'], ['see']));
    const own = await forkInto('alice', groupWork, roomId);
    const from = { from: own.toHexString() };

    expect((await merge('dave', groupWork, from)).status).toBe(404);
    expect((await merge('erin', groupWork, from)).status).toBe(403);
    expect((await merge('bob', groupWork, { from: hidden.toHexString() })).status).toBe(404);
    expect((await merge('bob', groupWork, { from: groupWork.toHexString() })).status).toBe(400);
    expect((await merge('bob', groupWork, {})).status).toBe(400);
    expect((await merge('bob', groupWork, { from: 'kaputt' })).status).toBe(400);
    expect((await merge('bob', groupWork, from)).status).toBe(201);
  });
});
