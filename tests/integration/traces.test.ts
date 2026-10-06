import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import type { ActorRecord } from '../../src/db/collections/actors.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { latestEvent, readEvents } from '../../src/db/collections/events.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { setGrant } from '../../src/db/collections/grants.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createWorkpieceHub, type Connection, type WorkpieceHub } from '../../src/realtime/hub.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createServer } from '../../src/routes/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_traces_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;
let hub: WorkpieceHub;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;

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
  // In through a grant at the room, as a group in it no longer opens anything.
  await setGrant(storage.db, {
    groupId: group._id,
    scope: { kind: 'room', id: room._id },
    rights: ['see', 'speak', 'edit', 'plan'],
    setBy: 'alice',
  });
  return workpiece._id;
}

const tokenOf = (actor: string) =>
  jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' });

const addressOf = (workpieceId: ObjectId) =>
  `ws://127.0.0.1:${port}/ws/${workpieceId.toHexString()}`;

const open = (workpieceId: ObjectId, actor: string) =>
  connectClient(addressOf(workpieceId), ['bearer', tokenOf(actor)]);

/** A connection without a socket, to drive the hub directly. */
const quiet = (actorId: string): Connection => ({
  actor: { actorId },
  send: () => {},
  close: () => {},
});

const on = (workpieceId: ObjectId) => ({ kind: 'workpiece', id: workpieceId });

const traced = (workpieceId: ObjectId, kind: string, createdBy: string) =>
  waitFor(
    async () =>
      (await latestEvent(storage.db, { anchor: on(workpieceId), kind, createdBy })) !== null,
  );

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

describe('presence', () => {
  it('keeps arriving and leaving as two events', async () => {
    const workpieceId = await freshWorkpiece();

    const alice = await open(workpieceId, 'alice');
    await alice.synced;
    expect(await traced(workpieceId, 'joined', 'alice')).toBe(true);

    await alice.close();
    expect(await traced(workpieceId, 'left', 'alice')).toBe(true);

    const all = await readEvents(storage.db, { anchor: on(workpieceId), createdBy: 'alice' });
    expect(all.map((event) => event.kind)).toEqual(['left', 'joined']);
  });

  it('records the actor on the way in', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;

    const actors = storage.db.collection<ActorRecord>('actors');
    expect(await waitFor(async () => (await actors.findOne({ _id: 'alice' })) !== null)).toBe(true);

    const stored = await actors.findOne({ _id: 'alice' });
    expect(stored).toMatchObject({ _id: 'alice', label: 'alice' });
    expect(stored?.lastSeenAt).toBeInstanceOf(Date);

    await alice.close();
  });

  it('moves lastSeenAt again on the way out', async () => {
    const workpieceId = await freshWorkpiece();
    const carol = await open(workpieceId, 'carol');
    await carol.synced;

    const actors = storage.db.collection<ActorRecord>('actors');
    expect(await waitFor(async () => (await actors.findOne({ _id: 'carol' })) !== null)).toBe(true);
    const arrived = (await actors.findOne({ _id: 'carol' }))?.lastSeenAt;

    // Lets the clock move on, so the second timestamp can be told apart from the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await carol.close();

    expect(
      await waitFor(async () => {
        const left = (await actors.findOne({ _id: 'carol' }))?.lastSeenAt;
        return arrived !== undefined && left !== undefined && left > arrived;
      }),
    ).toBe(true);
  });

  it('marks where in the stream somebody left', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'erst');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === 1),
    ).toBe(true);

    await alice.close();
    expect(await traced(workpieceId, 'left', 'alice')).toBe(true);

    const left = await latestEvent(storage.db, {
      anchor: on(workpieceId),
      kind: 'left',
      createdBy: 'alice',
    });
    const newest = (await readUpdatesSince(storage.db, workpieceId)).at(-1);
    expect(left?.at).toEqual(newest?._id);
  });

  it('answers what happened while somebody was away', async () => {
    const workpieceId = await freshWorkpiece();

    const alice = await open(workpieceId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'erst');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === 1),
    ).toBe(true);
    await alice.close();
    expect(await traced(workpieceId, 'left', 'alice')).toBe(true);

    const bob = await open(workpieceId, 'bob');
    await bob.synced;
    bob.doc.getText('t').insert(4, ' dann');
    bob.doc.getText('t').insert(9, ' und noch was');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === 3),
    ).toBe(true);
    await bob.close();

    // D6.18: everything after the place alice left is what she missed.
    const mark = await latestEvent(storage.db, {
      anchor: on(workpieceId),
      kind: 'left',
      createdBy: 'alice',
    });
    const missed = await readUpdatesSince(storage.db, workpieceId, mark?.at);

    expect(missed).toHaveLength(2);
    expect(missed.every((row) => row.createdBy === 'bob')).toBe(true);
  });

  it('keeps one arrival and one leaving when somebody goes while it still loads', async () => {
    const workpieceId = await freshWorkpiece();
    const socket = new WebSocket(addressOf(workpieceId), ['bearer', tokenOf('alice')]);
    // Gone the moment the handshake is through, while the workpiece is still loading.
    socket.on('open', () => socket.close());

    expect(await traced(workpieceId, 'left', 'alice')).toBe(true);
    expect(await waitFor(() => gateway.countFor(workpieceId) === 0)).toBe(true);
    // Gives a second leaving, if there were one, the time to be written.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const all = await readEvents(storage.db, { anchor: on(workpieceId), createdBy: 'alice' });
    expect(all.map((event) => event.kind)).toEqual(['left', 'joined']);
  });

  it('leaves one trace, however often a connection says goodbye', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = quiet('alice');
    const bob = quiet('bob');
    await hub.join(workpieceId, alice);
    await hub.join(workpieceId, bob);

    await hub.leave(workpieceId, alice);
    await hub.leave(workpieceId, alice);
    await hub.leave(workpieceId, bob);

    const left = await readEvents(storage.db, { anchor: on(workpieceId), kind: 'left' });
    expect(left.map((event) => event.createdBy).toSorted()).toEqual(['alice', 'bob']);
  });

  it('lets go quietly of a workpiece that could not be loaded', async () => {
    const unknown = new ObjectId();
    const alice = quiet('alice');

    const joining = hub.join(unknown, alice);
    const leaving = hub.leave(unknown, alice);

    await expect(joining).rejects.toThrowError(/unknown workpiece/);
    await expect(leaving).resolves.toBeUndefined();
    expect(hub.count(unknown)).toBe(0);
  });

  it('writes left for everyone still connected when the service shuts down', async () => {
    const workpieceId = await freshWorkpiece();
    const ownServer = createServer({ logger: silent });
    const ownGateway = attachGateway({
      server: ownServer,
      db: storage.db,
      hub: createWorkpieceHub({ db: storage.db, logger: silent }),
      checkToken: createTokenCheck({ key: secret, algorithm: 'HS256' }),
      logger: silent,
    });
    await new Promise<void>((resolve) => ownServer.listen(0, resolve));
    const ownPort = (ownServer.address() as AddressInfo).port;

    const alice = await connectClient(`ws://127.0.0.1:${ownPort}/ws/${workpieceId.toHexString()}`, [
      'bearer',
      tokenOf('alice'),
    ]);
    await alice.synced;
    expect(await traced(workpieceId, 'joined', 'alice')).toBe(true);

    await ownGateway.close();
    await new Promise<void>((resolve) => ownServer.close(() => resolve()));

    // Read straight away: the shutdown itself waited until it was written.
    const left = await latestEvent(storage.db, {
      anchor: on(workpieceId),
      kind: 'left',
      createdBy: 'alice',
    });
    expect(left).not.toBeNull();
  });

  it('keeps one workpiece for whoever comes right after the last two left together', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = quiet('alice');
    const bob = quiet('bob');
    const first = await hub.join(workpieceId, alice);
    await hub.join(workpieceId, bob);

    // A change, so each of the two releases has a fold to write and takes a moment.
    first.doc.transact(() => first.doc.getText('t').insert(0, 'x'), alice);
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === 1),
    ).toBe(true);

    // Only narrows the window in which the second release used to drop the newer workpiece.
    const aliceLeaving = hub.leave(workpieceId, alice);
    const bobLeaving = hub.leave(workpieceId, bob);
    await aliceLeaving;
    const carol = quiet('carol');
    const carolHolds = await hub.join(workpieceId, carol);
    await bobLeaving;
    const dave = quiet('dave');
    const daveHolds = await hub.join(workpieceId, dave);

    expect(daveHolds).toBe(carolHolds);
    expect(hub.count(workpieceId)).toBe(2);

    await hub.leave(workpieceId, carol);
    await hub.leave(workpieceId, dave);
  });
});

describe('checkpoint', () => {
  it('holds the moment with a name and a why', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'stand');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === 1),
    ).toBe(true);

    const marked = await hub.checkpoint(workpieceId, {
      createdBy: 'alice',
      label: 'Abgabe 1',
      reason: 'vor dem Umbau des Kundenteils',
    });

    expect(marked).toMatchObject({
      kind: 'checkpoint',
      createdBy: 'alice',
      label: 'Abgabe 1',
      reason: 'vor dem Umbau des Kundenteils',
    });

    const newest = (await readUpdatesSince(storage.db, workpieceId)).at(-1);
    expect(marked.at).toEqual(newest?._id);

    await alice.close();
  });

  it('carries neither name nor why when nobody gave one', async () => {
    const workpieceId = await freshWorkpiece();
    const marked = await hub.checkpoint(workpieceId, { createdBy: 'carol' });

    expect(marked.label).toBeUndefined();
    expect(marked.reason).toBeUndefined();
  });

  it('works on a workpiece nobody has open and does not open it', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'geschlossen');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === 1),
    ).toBe(true);
    await alice.close();
    expect(await waitFor(() => gateway.countFor(workpieceId) === 0)).toBe(true);

    const marked = await hub.checkpoint(workpieceId, {
      createdBy: 'carol',
      label: 'nachtraeglich',
    });

    const newest = (await readUpdatesSince(storage.db, workpieceId)).at(-1);
    expect(marked.at).toEqual(newest?._id);
    expect(gateway.countFor(workpieceId)).toBe(0);
  });

  it('points at nothing on a workpiece that was never changed', async () => {
    const workpieceId = await freshWorkpiece();
    const marked = await hub.checkpoint(workpieceId, { createdBy: 'alice', label: 'leer' });

    expect(marked.at).toBeUndefined();
  });

  it('refuses a workpiece nobody created', async () => {
    await expect(hub.checkpoint(new ObjectId(), { createdBy: 'alice' })).rejects.toThrowError(
      /unknown workpiece/,
    );
  });

  it('marks what has arrived, and loses nothing that is still on its way', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = await open(workpieceId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'vorher');
    const marking = hub.checkpoint(workpieceId, { createdBy: 'alice', label: 'gleichzeitig' });
    alice.doc.getText('t').insert(6, ' nachher');
    const marked = await marking;

    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === 2),
    ).toBe(true);
    const stored = await readUpdatesSince(storage.db, workpieceId);

    // The service can only mark what has reached it. A change still on the wire lands
    // behind the mark, never inside it, and the mark never names something that is
    // not in the stream.
    if (marked.at === undefined) {
      expect(stored.length).toBeGreaterThan(0);
    } else {
      expect(stored.some((row) => row._id.equals(marked.at!))).toBe(true);
    }

    await alice.close();
    expect(await waitFor(() => gateway.countFor(workpieceId) === 0)).toBe(true);

    const bob = await open(workpieceId, 'bob');
    await bob.synced;
    expect(await waitFor(() => bob.doc.getText('t').toString() === 'vorher nachher')).toBe(true);
    await bob.close();
  });
});
