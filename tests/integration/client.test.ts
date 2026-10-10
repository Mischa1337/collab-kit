import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import type { ObjectId } from 'mongodb';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Closed, Conflict, Session, Status } from '../../client/src/api.ts';
import { createCollabKitApi } from '../../client/src/index.ts';
import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { removeGrant, setGrant, type GrantChange } from '../../src/db/collections/grants.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import {
  attachGateway,
  createWorkpieceHub,
  forkWorkpiece,
  type Gateway,
  type WorkpieceHub,
} from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';
import { waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;
let hub: WorkpieceHub;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let url: string;

const tokenOf = (actor: string) =>
  jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' });

/** Where a test works: the workpiece, its room, and the groups that write and that read there. */
interface Place {
  readonly workpieceId: ObjectId;
  readonly roomId: ObjectId;
  readonly writers: ObjectId;
  readonly readers: ObjectId;
}

/** Gives a group these rights at the room, in place of what it held there. */
const grant = (groupId: ObjectId, roomId: ObjectId, rights: GrantChange['rights']) =>
  setGrant(storage.db, { groupId, scope: { kind: 'room', id: roomId }, rights, setBy: 'alice' });

/** A workpiece holding units in units: alice and bob write, erin reads, dave is in no group. */
async function freshWorkpiece(): Promise<Place> {
  const workpiece = await createWorkpiece(storage.db, {
    name: 'Entwurf',
    createdBy: 'alice',
    units: [{ path: ['units'] }],
  });
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  await addToRoom(storage.db, room._id, {
    kind: 'workpiece',
    id: workpiece._id,
    addedBy: 'alice',
  });
  const writers = await createGroup(storage.db, {
    name: 'Schreibende',
    createdBy: 'alice',
    members: ['alice', 'bob'],
  });
  const readers = await createGroup(storage.db, {
    name: 'Lesende',
    createdBy: 'alice',
    members: ['erin'],
  });
  await grant(writers._id, room._id, ['see', 'edit']);
  await grant(readers._id, room._id, ['see']);
  return {
    workpieceId: workpiece._id,
    roomId: room._id,
    writers: writers._id,
    readers: readers._id,
  };
}

// Every session a test opens, closed after it.
const opened: Session[] = [];

/** Opens a session with this token source, as a tool would. */
function openWith(getToken: () => string, workpieceId: ObjectId): Session {
  const session = createCollabKitApi({ url, getToken }).open(workpieceId.toHexString());
  opened.push(session);
  return session;
}

/** Opens a session as this person. */
const open = (actor: string, workpieceId: ObjectId) => openWith(() => tokenOf(actor), workpieceId);

/** Waits until this many changes of the workpiece are stored. */
const stored = async (workpieceId: ObjectId, count: number) =>
  expect(
    await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === count),
  ).toBe(true);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a call throws, to look at more than its message. */
function thrownBy(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  hub = createWorkpieceHub({ db: storage.db, logger: silent });
  const checkToken = createTokenCheck({ key: secret, algorithm: 'HS256' });
  server = createServer({
    logger: silent,
    api: createApi({
      db: storage.db,
      hub,
      checkToken,
      logger: silent,
      recheckAccess: () => gateway.recheck(),
    }),
  });
  gateway = attachGateway({ server, db: storage.db, hub, checkToken, logger: silent });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  for (const session of opened.splice(0)) {
    session.close();
  }
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await storage.db.dropDatabase();
  await storage.close();
});

describe('units', () => {
  it('brings a change to the other session, remote there and local here', async () => {
    const { workpieceId } = await freshWorkpiece();
    const alice = open('alice', workpieceId);
    const bob = open('bob', workpieceId);
    await Promise.all([alice.synced, bob.synced]);

    const seenByAlice: [string[], boolean][] = [];
    const seenByBob: [string[], boolean][] = [];
    alice.units.onChange((keys, remote) => seenByAlice.push([keys.toSorted(), remote]));
    bob.units.onChange((keys, remote) => seenByBob.push([keys.toSorted(), remote]));

    alice.units.update({ set: { a: { label: 'A' }, b: 2 } });

    expect(await waitFor(() => bob.units.get('b') === 2)).toBe(true);
    expect(bob.units.get('a')).toEqual({ label: 'A' });
    expect(seenByBob).toEqual([[['a', 'b'], true]]);
    expect(seenByAlice).toEqual([[['a', 'b'], false]]);

    bob.units.update({ delete: ['a'] });

    expect(await waitFor(() => alice.units.get('a') === undefined)).toBe(true);
    expect(alice.units.entries()).toEqual([['b', 2]]);
  });

  it('lets a reader follow without writing: mayWrite is false and update throws', async () => {
    const { workpieceId } = await freshWorkpiece();
    const alice = open('alice', workpieceId);
    const erin = open('erin', workpieceId);
    await Promise.all([alice.synced, erin.synced]);

    expect(alice.mayWrite).toBe(true);
    expect(erin.mayWrite).toBe(false);
    expect(thrownBy(() => erin.units.update({ set: { a: 1 } }))).toMatchObject({
      name: 'CollabKitError',
      status: 403,
    });

    // Nothing went out, so CK had no reason to close with 1008.
    alice.units.update({ set: { a: 2 } });
    expect(await waitFor(() => erin.units.get('a') === 2)).toBe(true);
    expect(erin.status).toBe('connected');
  });

  it('sends on connect what changed while disconnected, asking for a token again', async () => {
    const { workpieceId } = await freshWorkpiece();
    let asked = 0;
    const alice = openWith(() => {
      asked += 1;
      return tokenOf('alice');
    }, workpieceId);
    const bob = open('bob', workpieceId);
    await Promise.all([alice.synced, bob.synced]);
    expect(await waitFor(() => bob.presence.people().length === 2)).toBe(true);

    alice.disconnect();
    expect(alice.status).toBe('disconnected');
    // Gone for the others at once, not only when presence runs out.
    expect(await waitFor(() => bob.presence.people().length === 1)).toBe(true);

    alice.units.update({ set: { a: 1 } });
    await pause(200);
    expect(bob.units.get('a')).toBeUndefined();

    alice.connect();

    expect(await waitFor(() => bob.units.get('a') === 1)).toBe(true);
    expect(alice.status).toBe('connected');
    expect(asked).toBe(2);
  });

  it('keeps original and fork apart, each in a session of its own', async () => {
    const place = await freshWorkpiece();
    const original = open('alice', place.workpieceId);
    await original.synced;
    original.units.update({ set: { a: 1 } });
    await stored(place.workpieceId, 1);

    const fork = await forkWorkpiece(storage.db, hub, place.workpieceId, {
      name: 'Abzweig',
      createdBy: 'alice',
      roomId: place.roomId,
    });
    const copy = open('bob', fork._id);
    await copy.synced;
    expect(copy.units.get('a')).toBe(1);

    original.units.update({ set: { b: 2 } });
    copy.units.update({ set: { c: 3 } });
    await stored(place.workpieceId, 2);
    await stored(fork._id, 2);

    // Read again from CK: neither took on the state of the other.
    const again = [open('bob', place.workpieceId), open('alice', fork._id)];
    await Promise.all(again.map((session) => session.synced));
    expect(again[0]?.units.entries().toSorted()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(again[1]?.units.entries().toSorted()).toEqual([
      ['a', 1],
      ['c', 3],
    ]);
  });
});

describe('presence', () => {
  it('counts two sessions of one person as one person, each with its entry', async () => {
    const { workpieceId } = await freshWorkpiece();
    const first = open('alice', workpieceId);
    const second = open('alice', workpieceId);
    const bob = open('bob', workpieceId);
    await Promise.all([first.synced, second.synced, bob.synced]);

    // The fields are the tool's, person stays what GET /me said.
    first.presence.set({ pointer: 1, person: { id: 'mallory' } });

    const aliceSeen = () => bob.presence.people().find((person) => person.id === 'alice');
    expect(
      await waitFor(
        () =>
          bob.presence.people().length === 2 &&
          aliceSeen()?.clients.length === 2 &&
          aliceSeen()?.clients.some((client) => client.state['pointer'] === 1) === true,
      ),
    ).toBe(true);

    expect(aliceSeen()).toMatchObject({ id: 'alice', name: 'alice', self: false });
    expect(
      aliceSeen()
        ?.clients.map((client) => client.clientId)
        .toSorted(),
    ).toEqual([first.clientId, second.clientId].toSorted());
    expect(
      aliceSeen()?.clients.find((client) => client.clientId === first.clientId)?.state,
    ).toEqual({ pointer: 1, person: { id: 'alice', name: 'alice' } });
    expect(bob.presence.people().find((person) => person.id === 'bob')?.self).toBe(true);
    expect(first.presence.people().find((person) => person.id === 'alice')?.self).toBe(true);
  });
});

describe('rights and ends', () => {
  it('comes back after 4409 with the new rights and the units it had', async () => {
    const place = await freshWorkpiece();
    const alice = open('alice', place.workpieceId);
    const erin = open('erin', place.workpieceId);
    await Promise.all([alice.synced, erin.synced]);
    alice.units.update({ set: { a: 1 } });
    expect(await waitFor(() => erin.units.get('a') === 1)).toBe(true);

    const told: boolean[] = [];
    const statuses: Status[] = [];
    erin.on('rightsChanged', (mayWrite) => told.push(mayWrite));
    erin.on('status', (status) => statuses.push(status));

    await grant(place.readers, place.roomId, ['see', 'edit']);
    await gateway.recheck();

    expect(await waitFor(() => erin.mayWrite && erin.status === 'connected')).toBe(true);
    expect(told).toEqual([true]);
    expect(statuses).toEqual(['disconnected', 'connecting', 'connected']);
    expect(erin.units.get('a')).toBe(1);

    erin.units.update({ set: { b: 2 } });
    expect(await waitFor(() => alice.units.get('b') === 2)).toBe(true);
  });

  it('ends with closed on 4403 and does not come back', async () => {
    const place = await freshWorkpiece();
    const bob = open('bob', place.workpieceId);
    await bob.synced;
    const closed: Closed[] = [];
    bob.on('closed', (reason) => closed.push(reason));

    await removeGrant(storage.db, {
      groupId: place.writers,
      scope: { kind: 'room', id: place.roomId },
      removedBy: 'alice',
    });
    await gateway.recheck();

    expect(await waitFor(() => closed.length === 1)).toBe(true);
    expect(closed).toEqual([{ code: 4403, reason: 'access withdrawn' }]);
    // Long enough for several attempts, had it tried again.
    await pause(600);
    expect(bob.status).toBe('closed');
    expect(gateway.countFor(place.workpieceId)).toBe(0);
  });

  it('ends before connecting when the person may not see the workpiece', async () => {
    const { workpieceId } = await freshWorkpiece();
    const dave = open('dave', workpieceId);

    await expect(dave.synced).rejects.toMatchObject({ name: 'CollabKitError', status: 4403 });
    expect(dave.status).toBe('closed');
    expect(gateway.countFor(workpieceId)).toBe(0);
  });

  it('asks once more for a token CK rejects, then ends with 4401', async () => {
    const { workpieceId } = await freshWorkpiece();
    let asked = 0;
    const session = openWith(() => {
      asked += 1;
      return 'no token';
    }, workpieceId);

    await expect(session.synced).rejects.toMatchObject({ status: 4401 });
    expect(asked).toBe(2);
  });

  it('rejects synced when the tool closes the session before', async () => {
    const { workpieceId } = await freshWorkpiece();
    const session = open('alice', workpieceId);

    session.close();

    await expect(session.synced).rejects.toMatchObject({ status: 1000 });
    expect(session.status).toBe('closed');
  });
});

describe('conflicts', () => {
  it('reports a change lost on the same unit to both, mine to the loser', async () => {
    const { workpieceId } = await freshWorkpiece();
    const alice = open('alice', workpieceId);
    const bob = open('bob', workpieceId);
    await Promise.all([alice.synced, bob.synced]);
    const toAlice: Conflict[] = [];
    const toBob: Conflict[] = [];
    alice.on('conflict', (conflict) => toAlice.push(conflict));
    bob.on('conflict', (conflict) => toBob.push(conflict));

    // Alice sets the key while away, bob while there: neither knows of the other.
    alice.disconnect();
    alice.units.update({ set: { k: 'A' } });
    bob.units.update({ set: { k: 'B' } });
    await stored(workpieceId, 1);
    alice.connect();

    expect(await waitFor(() => toAlice.length === 1 && toBob.length === 1)).toBe(true);
    // The larger Yjs client keeps the key.
    const loser = alice.clientId < bob.clientId ? 'alice' : 'bob';
    const winner = loser === 'alice' ? 'bob' : 'alice';
    for (const conflict of [...toAlice, ...toBob]) {
      expect(conflict).toMatchObject({
        unit: 'k',
        cause: 'overwritten',
        loser,
        winner,
        names: { alice: 'alice', bob: 'bob' },
      });
      expect(conflict.event.kind).toBe('work-lost');
    }
    expect(toAlice[0]?.mine).toBe(loser === 'alice');
    expect(toBob[0]?.mine).toBe(loser === 'bob');
  });
});
