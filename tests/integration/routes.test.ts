import jwt from 'jsonwebtoken';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createWorkpieceHub } from '../../src/realtime/hub.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_routes_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const secret = 'routes-secret';
const logger = pino({ level: 'silent' });

const tokenFor = (subject: string) => jwt.sign({ sub: subject }, secret, { algorithm: 'HS256' });
const alice = tokenFor('alice');
const bob = tokenFor('bob');

let storage: Storage;
let server: ReturnType<typeof createServer>;

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const hub = createWorkpieceHub({ db: storage.db, logger });
  server = createServer({
    logger,
    api: createApi({ db: storage.db, hub, checkToken: createTokenCheck({ key: secret }), logger }),
  });
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

/** The whole first run: room, group, workpiece, and the socket address at the end. */
async function setUp(): Promise<{ roomId: string; groupId: string; workpieceId: string }> {
  const room = await request(server).post('/rooms').set(as(alice)).send({ name: 'Seminar' });
  const group = await request(server)
    .post('/groups')
    .set(as(alice))
    .send({ name: 'Teilnehmende', members: ['alice', 'bob'] });
  const workpiece = await request(server)
    .post('/workpieces')
    .set(as(alice))
    .send({ name: 'Entwurf', contract: { kind: 'sql-skript' } });

  const roomId = room.body._id as string;
  const into = (entry: { kind: string; id: string }) =>
    request(server).post(`/rooms/${roomId}/contains`).set(as(alice)).send(entry);

  await into({ kind: 'group', id: group.body._id as string });
  await into({ kind: 'workpiece', id: workpiece.body._id as string });

  return {
    roomId,
    groupId: group.body._id as string,
    workpieceId: workpiece.body._id as string,
  };
}

describe('the guard in front of everything', () => {
  it('refuses a request without a token', async () => {
    expect((await request(server).post('/rooms').send({ name: 'x' })).status).toBe(401);
  });

  it('refuses a token from another secret exactly alike', async () => {
    const forged = jwt.sign({ sub: 'alice' }, 'another-secret', { algorithm: 'HS256' });

    expect((await request(server).get('/me/groups').set(as(forged))).status).toBe(401);
  });
});

describe('setting a room up', () => {
  it('walks the whole way and ends at an openable workpiece', async () => {
    const { roomId, workpieceId } = await setUp();

    const room = await request(server).get(`/rooms/${roomId}`).set(as(bob));
    expect(room.status).toBe(200);
    expect(room.body.contains).toHaveLength(2);

    // bob is in a group the room bundles, so the workpiece is his to open.
    expect((await request(server).get(`/workpieces/${workpieceId}`).set(as(bob))).status).toBe(200);
  });

  it('takes the actor from the token and never from the body', async () => {
    const room = await request(server)
      .post('/rooms')
      .set(as(bob))
      .send({ name: 'Untergeschoben', createdBy: 'alice' });

    expect(room.body.createdBy).toBe('bob');
  });

  it('keeps the contract of the tool untouched', async () => {
    const { workpieceId } = await setUp();
    const workpiece = await request(server).get(`/workpieces/${workpieceId}`).set(as(alice));

    expect(workpiece.body.contract).toEqual({ kind: 'sql-skript' });
  });

  it('refuses a room without a name', async () => {
    expect((await request(server).post('/rooms').set(as(alice)).send({})).status).toBe(400);
  });

  it('answers a malformed key with 400 and an unknown one with 404', async () => {
    expect((await request(server).get('/rooms/nonsense').set(as(alice))).status).toBe(400);
    expect(
      (await request(server).get('/rooms/000000000000000000000000').set(as(alice))).status,
    ).toBe(404);
  });
});

describe('who may change what', () => {
  it('keeps somebody who did not create the room out of it', async () => {
    const { roomId } = await setUp();

    const pushed = await request(server)
      .post(`/rooms/${roomId}/contains`)
      .set(as(bob))
      .send({ kind: 'group', id: '000000000000000000000000' });

    expect(pushed.status).toBe(403);
  });

  it('lets nobody add themselves to a group they did not create', async () => {
    const { groupId } = await setUp();
    const carol = tokenFor('carol');

    const added = await request(server)
      .post(`/groups/${groupId}/members`)
      .set(as(carol))
      .send({ actorId: 'carol' });

    expect(added.status).toBe(403);
  });

  it('hides a room from somebody in none of its groups', async () => {
    const { roomId } = await setUp();
    const carol = tokenFor('carol');

    expect((await request(server).get(`/rooms/${roomId}`).set(as(carol))).status).toBe(404);
  });

  it('shows a group to its members and hides it from everybody else', async () => {
    const { groupId } = await setUp();
    const carol = tokenFor('carol');

    expect((await request(server).get(`/groups/${groupId}`).set(as(bob))).status).toBe(200);
    expect((await request(server).get(`/groups/${groupId}`).set(as(carol))).status).toBe(404);
  });

  it('hides a workpiece that sits in no room from everyone but its creator', async () => {
    const loose = await request(server).post('/workpieces').set(as(alice)).send({ name: 'Allein' });
    const id = loose.body._id as string;

    expect((await request(server).get(`/workpieces/${id}`).set(as(alice))).status).toBe(200);
    expect((await request(server).get(`/workpieces/${id}`).set(as(bob))).status).toBe(404);
  });
});

describe('settings, which the service stores and never reads', () => {
  it('takes whatever shape the tool chose and gives it back unchanged', async () => {
    const { groupId } = await setUp();
    const settings = { roles: { moderation: ['alice'] }, rotation: 'weekly' };

    const patched = await request(server)
      .patch(`/groups/${groupId}`)
      .set(as(alice))
      .send({ settings });

    expect(patched.body.settings).toEqual(settings);
  });
});

describe('the room as a channel', () => {
  it('carries what a tool reports and hands it back after the cut', async () => {
    const { roomId } = await setUp();

    const first = await request(server)
      .post('/events')
      .set(as(alice))
      .send({ kind: 'visit', anchor: { kind: 'room', id: roomId } });

    expect(first.status).toBe(201);
    expect(first.body.actorId).toBe('alice');

    await request(server)
      .post('/events')
      .set(as(bob))
      .send({ kind: 'visit', anchor: { kind: 'room', id: roomId } });

    const since = await request(server)
      .get(`/rooms/${roomId}/events`)
      .query({ since: first.body._id as string })
      .set(as(bob));

    expect(since.body).toHaveLength(1);
    expect(since.body[0].actorId).toBe('bob');
  });

  it('gathers what the room bundles, not only what anchors at the room', async () => {
    const { roomId, workpieceId } = await setUp();

    await request(server)
      .post('/events')
      .set(as(alice))
      .send({ kind: 'note', anchor: { kind: 'workpiece', id: workpieceId } });

    const events = await request(server).get(`/rooms/${roomId}/events`).set(as(bob));

    expect(events.body.map((event: { kind: string }) => event.kind)).toContain('note');
  });

  it('refuses a trace on a workpiece the actor may not open', async () => {
    const loose = await request(server).post('/workpieces').set(as(alice)).send({ name: 'Allein' });

    const refused = await request(server)
      .post('/events')
      .set(as(bob))
      .send({ kind: 'note', anchor: { kind: 'workpiece', id: loose.body._id as string } });

    expect(refused.status).toBe(404);
  });
});

describe('the history of a workpiece', () => {
  it('answers with an empty chain and a checkpoint that names the moment', async () => {
    const { workpieceId } = await setUp();

    const updates = await request(server).get(`/workpieces/${workpieceId}/updates`).set(as(bob));

    expect(updates.status).toBe(200);
    expect(updates.body).toEqual([]);

    const marked = await request(server)
      .post(`/workpieces/${workpieceId}/checkpoints`)
      .set(as(bob))
      .send({ label: 'Abgabe', reason: 'so wollen wir es lassen' });

    expect(marked.status).toBe(201);
    expect(marked.body).toMatchObject({
      kind: 'checkpoint',
      actorId: 'bob',
      label: 'Abgabe',
      reason: 'so wollen wir es lassen',
    });
  });

  it('keeps the chain from somebody who may not open the workpiece', async () => {
    const loose = await request(server).post('/workpieces').set(as(alice)).send({ name: 'Allein' });

    const refused = await request(server)
      .get(`/workpieces/${loose.body._id as string}/updates`)
      .set(as(bob));

    expect(refused.status).toBe(404);
  });
});
