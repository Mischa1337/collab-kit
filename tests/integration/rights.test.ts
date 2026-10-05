import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
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

const database = `collab_kit_rights_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const secret = 'rights-secret';
const logger = pino({ level: 'silent' });

const tokenFor = (subject: string, claims: object = {}) =>
  jwt.sign({ sub: subject, ...claims }, secret, { algorithm: 'HS256' });
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

// The dozent stands at the top through the token, everyone else only holds what grants give.
const dozent = tokenFor('dozent', { globalRole: 'ADMIN' });
const tutor = tokenFor('tutor');
const alice = tokenFor('alice');
const bob = tokenFor('bob');

let storage: Storage;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  server = createServer({
    logger,
    api: createApi({
      db: storage.db,
      hub: createWorkpieceHub({ db: storage.db, logger }),
      checkToken: createTokenCheck({
        key: secret,
        algorithm: 'HS256',
        top: { claim: 'globalRole', values: ['ADMIN'] },
      }),
      logger,
      // No sockets in these tests, so there is nothing to ask again.
      recheckAccess: async () => {},
    }),
  });
  // Listening once, or supertest opens a port per request and parallel ones hang up.
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await storage.db.dropDatabase();
  await storage.close();
});

/** A room the dozent creates, by its key. */
async function room(): Promise<string> {
  const created = await request(server).post('/rooms').set(as(dozent)).send({ name: 'Übung' });
  return created.body._id as string;
}

/** A group the dozent creates with these members, by its key. */
async function group(members: readonly string[]): Promise<string> {
  const created = await request(server)
    .post('/groups')
    .set(as(dozent))
    .send({ name: 'Gruppe', members });
  return created.body._id as string;
}

/** A workpiece the dozent creates and puts into the room, by its key. */
async function workpieceIn(roomId: string): Promise<string> {
  const created = await request(server)
    .post('/workpieces')
    .set(as(dozent))
    .send({ name: 'Modell', contract: {} });
  const id = created.body._id as string;
  await request(server)
    .post(`/rooms/${roomId}/references`)
    .set(as(dozent))
    .send({ kind: 'workpiece', id });
  return id;
}

/** Sets rights over the route, by default as the dozent. */
function grant(
  groupId: string,
  scope: { kind: string; id: string } | undefined,
  rights: readonly string[],
  by = dozent,
) {
  return request(server).put('/grants').set(as(by)).send({ groupId, scope, rights });
}

/** A class: a room with a workpiece, a team with alice, tutors who manage the room. */
async function course() {
  const roomId = await room();
  const workpieceId = await workpieceIn(roomId);
  const team = await group(['alice']);
  const tutors = await group(['tutor']);
  await grant(tutors, { kind: 'room', id: roomId }, ['see', 'speak', 'edit', 'plan', 'manage']);
  return { roomId, workpieceId, team, tutors, at: { kind: 'room', id: roomId } };
}

describe('creating rooms and groups', () => {
  it('leaves it to whoever may manage everywhere', async () => {
    const leads = await group(['erin']);
    await grant(leads, undefined, ['manage']);

    const creating = [bob, dozent, tokenFor('erin')].flatMap((token) => [
      request(server).post('/rooms').set(as(token)).send({ name: 'Raum' }),
      request(server).post('/groups').set(as(token)).send({ name: 'Gruppe' }),
    ]);
    const created = await Promise.all(creating);

    expect(created.map((response) => response.status)).toEqual([403, 403, 201, 201, 201, 201]);
  });

  it('refuses before it reads the body, so a stranger learns nothing about it', async () => {
    expect((await request(server).post('/rooms').set(as(bob)).send({})).status).toBe(403);
  });
});

describe('handing rights on', () => {
  it('answers with the grant, which then reaches down from the room', async () => {
    const { team, at, workpieceId } = await course();

    const set = await grant(team, at, ['see', 'edit']);
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ groupId: team, scope: at, rights: ['see', 'edit'] });

    const rights = await request(server)
      .get('/me/rights')
      .query({ kind: 'workpiece', id: workpieceId })
      .set(as(alice));
    expect(rights.body).toEqual(['see', 'edit']);
  });

  it('refuses unknown rights, a kind of the tool and a missing group', async () => {
    const { team, at } = await course();

    const statuses = await Promise.all([
      grant(team, at, []),
      grant(team, at, ['see', 'fly']),
      grant(team, { kind: 'diagram', id: 'd-1' }, ['see']),
      grant(team, { kind: 'room', id: 'kein-schluessel' }, ['see']),
      request(server)
        .put('/grants')
        .set(as(dozent))
        .send({ rights: ['see'] }),
      request(server)
        .put('/grants')
        .set(as(dozent))
        .send({ groupId: team, rights: ['see'], reason: 42 }),
    ]);
    expect(statuses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
  });

  it('answers an unknown group or place as if it were not there', async () => {
    const { team, at } = await course();
    const nowhere = new ObjectId().toHexString();

    expect((await grant(nowhere, at, ['see'])).status).toBe(404);
    expect((await grant(team, { kind: 'room', id: nowhere }, ['see'])).status).toBe(404);
  });

  it('lets a tutor hand on only what the tutor holds, and only where', async () => {
    const { team, at, workpieceId } = await course();
    const elsewhere = { kind: 'room', id: await room() };

    expect((await grant(team, at, ['see', 'edit'], tutor)).status).toBe(200);
    expect(
      (await grant(team, { kind: 'workpiece', id: workpieceId }, ['plan'], tutor)).status,
    ).toBe(200);
    expect((await grant(team, at, ['see', 'decide'], tutor)).status).toBe(403);
    expect((await grant(team, undefined, ['see'], tutor)).status).toBe(403);
    // A room the tutor does not even see stays unknown.
    expect((await grant(team, elsewhere, ['see'], tutor)).status).toBe(404);
  });

  it('keeps a member without manage from handing anything on, even to the own group', async () => {
    const { team, at } = await course();
    await grant(team, at, ['see', 'edit']);

    expect((await grant(team, at, ['see', 'edit'], alice)).status).toBe(403);
  });

  it('takes rights away with manage at the place, and says whether there were any', async () => {
    const { team, roomId } = await course();
    await grant(team, { kind: 'room', id: roomId }, ['see']);
    const remove = (token: string, query: Record<string, string>) =>
      request(server).delete('/grants').query(query).set(as(token));
    const place = { groupId: team, scopeKind: 'room', scopeId: roomId };

    expect((await remove(alice, place)).status).toBe(403);
    expect((await remove(tutor, place)).body).toEqual({ removed: true });
    expect((await remove(tutor, place)).body).toEqual({ removed: false });
    expect((await remove(tutor, { groupId: team, scopeKind: 'room' })).status).toBe(400);
  });
});

describe('reading rights', () => {
  it('shows the grants at a place to whoever manages it, and those of a group at the group', async () => {
    const { team, tutors, roomId } = await course();
    await grant(team, { kind: 'room', id: roomId }, ['see']);
    const read = (token: string, query: Record<string, string>) =>
      request(server).get('/grants').query(query).set(as(token));

    const atRoom = await read(tutor, { scopeKind: 'room', scopeId: roomId });
    expect(atRoom.status).toBe(200);
    expect(atRoom.body.map((entry: { groupId: string }) => entry.groupId).toSorted()).toEqual(
      [team, tutors].toSorted(),
    );
    expect((await read(alice, { scopeKind: 'room', scopeId: roomId })).status).toBe(403);

    // Managing a room is not managing a group, the dozent at the top does both.
    expect((await read(tutor, { groupId: team })).status).toBe(403);
    expect((await read(dozent, { groupId: team })).body).toHaveLength(1);
    expect((await read(dozent, { groupId: team, scopeKind: 'room', scopeId: roomId })).status).toBe(
      400,
    );
  });

  it('tells each token its own rights: all at the top, none without a grant', async () => {
    const { roomId } = await course();
    const mine = (token: string, query: Record<string, string> = {}) =>
      request(server).get('/me/rights').query(query).set(as(token));

    expect((await mine(dozent)).body).toEqual(['see', 'speak', 'edit', 'plan', 'decide', 'manage']);
    expect((await mine(bob, { kind: 'room', id: roomId })).body).toEqual([]);
    expect((await mine(tutor, { kind: 'room', id: roomId })).body).toEqual([
      'see',
      'speak',
      'edit',
      'plan',
      'manage',
    ]);
    // Everywhere, the tutor holds nothing.
    expect((await mine(tutor)).body).toEqual([]);
    expect((await mine(bob, { kind: 'room' })).status).toBe(400);
  });
});

describe('groups under grants', () => {
  it('shows a group to its members and to whoever holds see at it', async () => {
    const team = await group(['alice']);
    const leads = await group(['bob']);
    const show = (token: string) => request(server).get(`/groups/${team}`).set(as(token));

    expect((await show(alice)).status).toBe(200);
    expect((await show(bob)).status).toBe(404);

    await grant(leads, { kind: 'group', id: team }, ['see']);
    expect((await show(bob)).status).toBe(200);
  });

  it('lets whoever manages a group change it, and nobody else', async () => {
    const team = await group(['alice', 'carol']);
    const leads = await group(['bob']);
    await grant(leads, { kind: 'group', id: team }, ['see', 'manage']);

    const settings = { role: 'team' };
    expect(
      (await request(server).patch(`/groups/${team}`).set(as(alice)).send({ settings })).status,
    ).toBe(403);
    expect(
      (await request(server).patch(`/groups/${team}`).set(as(bob)).send({ settings })).status,
    ).toBe(200);
    expect(
      (await request(server).delete(`/groups/${team}/members/carol`).set(as(bob))).status,
    ).toBe(200);
  });

  it('takes nobody into a group whose rights are not the taker’s to give', async () => {
    const { team, at } = await course();
    await grant(team, at, ['see', 'edit']);
    const leads = await group(['bob']);
    await grant(leads, { kind: 'group', id: team }, ['see', 'manage']);
    const take = () =>
      request(server).post(`/groups/${team}/members`).set(as(bob)).send({ actorId: 'dave' });

    // bob manages the group, but edit in the room is not his to hand on.
    expect((await take()).status).toBe(403);

    await grant(leads, at, ['see', 'edit', 'manage']);
    expect((await take()).status).toBe(201);
  });
});
