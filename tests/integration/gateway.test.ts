import net, { type AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import pino from 'pino';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createWorkpieceHub } from '../../src/realtime/hub.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_gateway_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const token = jwt.sign({ sub: 'alice', name: 'Alice' }, secret, { expiresIn: '15m' });

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;
let workpieceId: string;

type Attempt = { ok: true; socket: WebSocket } | { ok: false; status: number };

function tryOpen(
  path: string,
  protocols: string[] = ['bearer', token],
  at = port,
  origin?: string,
): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${at}${path}`,
      protocols,
      origin === undefined ? {} : { origin },
    );
    let settled = false;

    socket.on('open', () => {
      settled = true;
      resolve({ ok: true, socket });
    });
    socket.on('unexpected-response', (_request, response) => {
      settled = true;
      resolve({ ok: false, status: response.statusCode ?? 0 });
    });
    socket.on('error', (error) => {
      if (!settled) {
        reject(error);
      }
    });
  });
}

/**
 * The client is closed before the server has tidied up, so the count is awaited
 * instead of read straight away.
 */
async function waitForCount(expected: number, timeoutMs = 2000, on = gateway): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  /* eslint-disable no-await-in-loop */
  while (on.countFor(new ObjectId(workpieceId)) !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  /* eslint-enable no-await-in-loop */

  return on.countFor(new ObjectId(workpieceId));
}

/** Does the handshake by hand, so a test can send what no WebSocket client would. */
async function openRaw(at = port): Promise<net.Socket> {
  const raw = net.connect(at, '127.0.0.1');
  raw.on('error', () => {});
  await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
  raw.write(
    `GET /ws/${workpieceId} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
      'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: bearer, ${token}\r\n\r\n`,
  );
  return raw;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tokenFor = (actor: string) =>
  jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' });

/** Resolves with the code the server closed the socket with. */
function closedWith(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.on('close', (code) => resolve(code));
  });
}

function close(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.on('close', () => resolve());
    socket.close();
  });
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const workpiece = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
  workpieceId = workpiece._id.toHexString();

  // Opening needs a room that bundles the workpiece and a group alice is in.
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  const group = await createGroup(storage.db, {
    name: 'Teilnehmende',
    createdBy: 'alice',
    members: ['alice'],
  });
  await addToRoom(storage.db, room._id, {
    kind: 'workpiece',
    id: workpiece._id,
    addedBy: 'alice',
  });
  await addToRoom(storage.db, room._id, { kind: 'group', id: group._id, addedBy: 'alice' });

  server = createServer({ logger: pino({ level: 'silent' }) });
  gateway = attachGateway({
    server,
    db: storage.db,
    hub: createWorkpieceHub({ db: storage.db, logger: pino({ level: 'silent' }) }),
    checkToken: createTokenCheck({ key: secret, algorithm: 'HS256' }),
    logger: pino({ level: 'silent' }),
    maxMessageBytes: 64 * 1024,
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

describe('the handshake', () => {
  it('lets a valid token through and counts the connection', async () => {
    const attempt = await tryOpen(`/ws/${workpieceId}`);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;

    expect(gateway.countFor(new ObjectId(workpieceId))).toBe(1);
    expect(attempt.socket.protocol).toBe('bearer');

    await close(attempt.socket);
    await expect(waitForCount(0)).resolves.toBe(0);
  });

  it('refuses a token from another secret with 401', async () => {
    const foreign = jwt.sign({ sub: 'mallory' }, 'anderes-geheimnis', { expiresIn: '15m' });

    await expect(tryOpen(`/ws/${workpieceId}`, ['bearer', foreign])).resolves.toEqual({
      ok: false,
      status: 401,
    });
  });

  it('refuses a handshake that offers no token', async () => {
    await expect(tryOpen(`/ws/${workpieceId}`, ['bearer'])).resolves.toEqual({
      ok: false,
      status: 401,
    });
  });

  it('refuses a token offered without bearer beside it, which a browser would drop', async () => {
    await expect(tryOpen(`/ws/${workpieceId}`, [token])).resolves.toEqual({
      ok: false,
      status: 401,
    });
  });

  it('refuses somebody who is in no group of the room with 404, as if it were not there', async () => {
    const stranger = jwt.sign({ sub: 'mallory', name: 'Mallory' }, secret, { expiresIn: '15m' });

    await expect(tryOpen(`/ws/${workpieceId}`, ['bearer', stranger])).resolves.toEqual({
      ok: false,
      status: 404,
    });
  });

  it('answers an unknown workpiece with 404', async () => {
    await expect(tryOpen('/ws/6aacfebc84651b67d9e70456')).resolves.toEqual({
      ok: false,
      status: 404,
    });
  });

  it('answers a malformed key with 400', async () => {
    await expect(tryOpen('/ws/kein-schluessel')).resolves.toEqual({ ok: false, status: 400 });
  });

  it('answers an unknown path with 404', async () => {
    await expect(tryOpen(`/sonstwo/${workpieceId}`)).resolves.toEqual({ ok: false, status: 404 });
  });

  it('holds two connections on the same workpiece at once', async () => {
    const first = await tryOpen(`/ws/${workpieceId}`);
    const second = await tryOpen(`/ws/${workpieceId}`);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(gateway.countFor(new ObjectId(workpieceId))).toBe(2);

    await close(first.socket);
    await expect(waitForCount(1)).resolves.toBe(1);

    await close(second.socket);
    await expect(waitForCount(0)).resolves.toBe(0);
  });
});

describe('what a client sends that makes no sense', () => {
  it('closes only that connection on an unusable message', async () => {
    const broken = await tryOpen(`/ws/${workpieceId}`);
    const other = await tryOpen(`/ws/${workpieceId}`);
    expect(broken.ok && other.ok).toBe(true);
    if (!broken.ok || !other.ok) return;

    const closing = closedWith(broken.socket);
    // A sync message of a kind that does not exist.
    broken.socket.send(new Uint8Array([0, 7]));

    await expect(closing).resolves.toBe(1007);
    expect(other.socket.readyState).toBe(WebSocket.OPEN);

    await close(other.socket);
    await expect(waitForCount(0)).resolves.toBe(0);
  });

  it('closes a connection that sends more than it may, and carries on', async () => {
    const greedy = await tryOpen(`/ws/${workpieceId}`);
    expect(greedy.ok).toBe(true);
    if (!greedy.ok) return;

    const closing = closedWith(greedy.socket);
    greedy.socket.send(new Uint8Array(128 * 1024));

    await expect(closing).resolves.toBe(1009);
    await expect(waitForCount(0)).resolves.toBe(0);
  });

  it('carries on after a frame that breaks the rules of WebSocket', async () => {
    const raw = await openRaw();
    await new Promise<void>((resolve) => raw.once('data', () => resolve()));
    // Every frame from a client must be masked; this one is not.
    raw.write(Buffer.from([0x82, 0x02, 0x00, 0x00]));
    await pause(100);
    raw.destroy();
    await expect(waitForCount(0)).resolves.toBe(0);

    const after = await tryOpen(`/ws/${workpieceId}`);
    expect(after.ok).toBe(true);
    if (after.ok) await close(after.socket);
    await expect(waitForCount(0)).resolves.toBe(0);
  });
});

describe('when the database cannot be reached', () => {
  // Nothing listens on port 9, so every query fails after the short selection timeout.
  const unreachable = new MongoClient(
    'mongodb://127.0.0.1:9/?directConnection=true&serverSelectionTimeoutMS=300',
  );
  const silent = pino({ level: 'silent' });
  let offlineServer: ReturnType<typeof createServer>;
  let offlineGateway: Gateway;
  let offlinePort: number;

  beforeAll(async () => {
    const db = unreachable.db('nirgends');
    offlineServer = createServer({ logger: silent });
    offlineGateway = attachGateway({
      server: offlineServer,
      db,
      hub: createWorkpieceHub({ db, logger: silent }),
      checkToken: createTokenCheck({ key: secret, algorithm: 'HS256' }),
      logger: silent,
    });
    await new Promise<void>((resolve) => offlineServer.listen(0, resolve));
    offlinePort = (offlineServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await offlineGateway.close();
    await new Promise<void>((resolve) => offlineServer.close(() => resolve()));
    await unreachable.close();
  });

  it('answers the handshake with 500', async () => {
    await expect(tryOpen(`/ws/${workpieceId}`, undefined, offlinePort)).resolves.toEqual({
      ok: false,
      status: 500,
    });
  });

  it('carries on when a client drops the connection while it is being checked', async () => {
    const raw = await openRaw(offlinePort);
    // Dropped hard while the check still waits for the database.
    await pause(50);
    raw.resetAndDestroy();
    await pause(400);

    await expect(tryOpen(`/ws/${workpieceId}`, undefined, offlinePort)).resolves.toEqual({
      ok: false,
      status: 500,
    });
  });
});

describe('the heartbeat', () => {
  const silent = pino({ level: 'silent' });
  let beatingServer: ReturnType<typeof createServer>;
  let beatingGateway: Gateway;
  let beatingPort: number;

  beforeAll(async () => {
    beatingServer = createServer({ logger: silent });
    beatingGateway = attachGateway({
      server: beatingServer,
      db: storage.db,
      hub: createWorkpieceHub({ db: storage.db, logger: silent }),
      checkToken: createTokenCheck({ key: secret, algorithm: 'HS256' }),
      logger: silent,
      heartbeatMs: 100,
    });
    await new Promise<void>((resolve) => beatingServer.listen(0, resolve));
    beatingPort = (beatingServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await beatingGateway.close();
    await new Promise<void>((resolve) => beatingServer.close(() => resolve()));
  });

  it('drops a connection that stops answering and keeps one that answers', async () => {
    const answering = await tryOpen(`/ws/${workpieceId}`, undefined, beatingPort);
    expect(answering.ok).toBe(true);
    if (!answering.ok) return;

    // A bare socket never answers a ping, like a laptop that was closed mid-session. It still
    // reads what arrives, or it would not notice being dropped.
    const mute = await openRaw(beatingPort);
    mute.resume();
    const dropped = new Promise<void>((resolve) => mute.once('close', () => resolve()));
    await expect(waitForCount(2, 2000, beatingGateway)).resolves.toBe(2);

    await expect(dropped).resolves.toBeUndefined();
    await expect(waitForCount(1, 2000, beatingGateway)).resolves.toBe(1);
    expect(answering.socket.readyState).toBe(WebSocket.OPEN);

    await close(answering.socket);
    await expect(waitForCount(0, 2000, beatingGateway)).resolves.toBe(0);
  });
});

describe('when access is taken away', () => {
  const silent = pino({ level: 'silent' });
  let apiServer: ReturnType<typeof createServer>;
  let apiGateway: Gateway;
  let apiPort: number;

  beforeAll(async () => {
    const hub = createWorkpieceHub({ db: storage.db, logger: silent });
    apiServer = createServer({
      logger: silent,
      api: createApi({
        db: storage.db,
        hub,
        checkToken: createTokenCheck({
          key: secret,
          algorithm: 'HS256',
          top: { claim: 'globalRole', values: ['ADMIN'] },
        }),
        logger: silent,
        recheckAccess: () => apiGateway.recheck(),
      }),
    });
    apiGateway = attachGateway({
      server: apiServer,
      db: storage.db,
      hub,
      checkToken: createTokenCheck({ key: secret, algorithm: 'HS256' }),
      logger: silent,
    });
    await new Promise<void>((resolve) => apiServer.listen(0, resolve));
    apiPort = (apiServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await apiGateway.close();
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  });

  /** bob is in one group of the room, carol in both; alice made room and groups. */
  async function seminar() {
    const workpiece = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });
    const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
    const all = await createGroup(storage.db, {
      name: 'Alle',
      createdBy: 'alice',
      members: ['bob', 'carol'],
    });
    const tutors = await createGroup(storage.db, {
      name: 'Tutorium',
      createdBy: 'alice',
      members: ['carol'],
    });
    for (const [kind, id] of [
      ['workpiece', workpiece._id],
      ['group', all._id],
      ['group', tutors._id],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      await addToRoom(storage.db, room._id, { kind, id, addedBy: 'alice' });
    }
    return { workpiece: workpiece._id, room: room._id, all: all._id };
  }

  async function openAs(actor: string, workpiece: ObjectId): Promise<WebSocket> {
    const attempt = await tryOpen(
      `/ws/${workpiece.toHexString()}`,
      ['bearer', tokenFor(actor)],
      apiPort,
    );
    if (!attempt.ok) {
      throw new Error(`${actor} could not open the workpiece: ${attempt.status}`);
    }
    return attempt.socket;
  }

  // Alice at the top, since changing a group takes manage at it.
  const removeAsAlice = (path: string) =>
    fetch(`http://127.0.0.1:${apiPort}${path}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${jwt.sign({ sub: 'alice', globalRole: 'ADMIN' }, secret)}`,
      },
    });

  it('closes the connection of whoever lost access, and only theirs', async () => {
    const { workpiece, all } = await seminar();
    const bob = await openAs('bob', workpiece);
    const carol = await openAs('carol', workpiece);
    const bobClosing = closedWith(bob);

    expect((await removeAsAlice(`/groups/${all.toHexString()}/members/bob`)).status).toBe(200);
    await expect(bobClosing).resolves.toBe(4403);

    // carol leaves this group too, but the other group of the room still lets her in.
    expect((await removeAsAlice(`/groups/${all.toHexString()}/members/carol`)).status).toBe(200);
    await pause(100);
    expect(carol.readyState).toBe(WebSocket.OPEN);

    await close(carol);
  });

  it('closes every connection when the workpiece leaves the room', async () => {
    const { workpiece, room } = await seminar();
    const closing = [
      closedWith(await openAs('bob', workpiece)),
      closedWith(await openAs('carol', workpiece)),
    ];

    const query = `kind=workpiece&id=${workpiece.toHexString()}`;
    expect((await removeAsAlice(`/rooms/${room.toHexString()}/references?${query}`)).status).toBe(
      200,
    );
    await expect(Promise.all(closing)).resolves.toEqual([4403, 4403]);
  });
});

describe('shutting down', () => {
  it('cuts off a client that does not answer, so the shutdown ends in time', async () => {
    const silent = pino({ level: 'silent' });
    const ownServer = createServer({ logger: silent });
    const ownGateway = attachGateway({
      server: ownServer,
      db: storage.db,
      hub: createWorkpieceHub({ db: storage.db, logger: silent }),
      checkToken: createTokenCheck({ key: secret, algorithm: 'HS256' }),
      logger: silent,
      shutdownGraceMs: 200,
    });
    await new Promise<void>((resolve) => ownServer.listen(0, resolve));
    const ownPort = (ownServer.address() as AddressInfo).port;

    // Reads everything but never answers the closing handshake.
    const mute = await openRaw(ownPort);
    mute.resume();
    await expect(waitForCount(1, 2000, ownGateway)).resolves.toBe(1);

    const started = Date.now();
    await ownGateway.close();
    expect(Date.now() - started).toBeLessThan(2000);

    mute.destroy();
    await new Promise<void>((resolve) => ownServer.close(() => resolve()));
  });
});

describe('where a connection comes from', () => {
  const silent = pino({ level: 'silent' });
  let guardedServer: ReturnType<typeof createServer>;
  let guardedGateway: Gateway;
  let guardedPort: number;

  beforeAll(async () => {
    guardedServer = createServer({ logger: silent });
    guardedGateway = attachGateway({
      server: guardedServer,
      db: storage.db,
      hub: createWorkpieceHub({ db: storage.db, logger: silent }),
      checkToken: createTokenCheck({ key: secret, algorithm: 'HS256' }),
      logger: silent,
      allowedOrigins: ['https://tool.example'],
    });
    await new Promise<void>((resolve) => guardedServer.listen(0, resolve));
    guardedPort = (guardedServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await guardedGateway.close();
    await new Promise<void>((resolve) => guardedServer.close(() => resolve()));
  });

  it('lets a listed origin in and refuses any other with 403', async () => {
    const path = `/ws/${workpieceId}`;
    const listed = await tryOpen(path, undefined, guardedPort, 'https://tool.example');
    expect(listed.ok).toBe(true);
    if (listed.ok) await close(listed.socket);

    await expect(tryOpen(path, undefined, guardedPort, 'https://fremd.example')).resolves.toEqual({
      ok: false,
      status: 403,
    });
  });
});
