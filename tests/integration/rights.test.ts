import jwt from 'jsonwebtoken';
import { Binary, ObjectId } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { touchActor } from '../../src/db/collections/actors.ts';
import type { EventRecord } from '../../src/db/collections/events.ts';
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
      decisionStates: ['accepted'],
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

/** A workpiece the dozent creates right in the room, by its key. */
async function workpieceIn(roomId: string): Promise<string> {
  const created = await request(server)
    .post('/workpieces')
    .set(as(dozent))
    .send({ name: 'Modell', contract: {}, roomId });
  return created.body._id as string;
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

/** The traces at a thing, oldest first, read straight from the database. */
function tracesAt(id: string): Promise<EventRecord[]> {
  return storage.db
    .collection<EventRecord>('events')
    .find({ 'anchor.id': new ObjectId(id) })
    .sort({ _id: 1 })
    .toArray();
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

describe('listing, renaming and deleting groups', () => {
  it('lists the own groups and those a token holds see at, all of them at the top', async () => {
    const team = await group(['alice']);
    const leads = await group(['bob']);
    const other = await group(['carol']);
    await grant(leads, { kind: 'group', id: team }, ['see']);
    const listed = async (token: string) =>
      (await request(server).get('/groups').set(as(token))).body.map(
        (entry: { _id: string }) => entry._id,
      );

    expect(await listed(alice)).toContain(team);
    expect(await listed(alice)).not.toContain(leads);
    expect(await listed(bob)).toEqual(expect.arrayContaining([team, leads]));
    expect(await listed(bob)).not.toContain(other);
    expect(await listed(dozent)).toEqual(expect.arrayContaining([team, leads, other]));
  });

  it('renames a group with manage at it and leaves a trace, but none for the same name', async () => {
    const team = await group(['alice']);
    const leads = await group(['bob']);
    await grant(leads, { kind: 'group', id: team }, ['see', 'manage']);
    const rename = (token: string) =>
      request(server).patch(`/groups/${team}`).set(as(token)).send({ name: 'Team Nord' });

    expect((await rename(tutor)).status).toBe(404);
    expect((await rename(alice)).status).toBe(403);
    const renamed = await rename(bob);
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Team Nord');
    expect((await rename(bob)).status).toBe(200);

    const traces = (await tracesAt(team)).filter((event) => event.kind === 'group-renamed');
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ createdBy: 'bob', detail: { to: 'Team Nord' } });
    const empty = await request(server).patch(`/groups/${team}`).set(as(bob)).send({});
    expect(empty.status).toBe(400);
  });

  it('deletes a group with manage at it: its grants go, and those held at it', async () => {
    const { roomId, team, at } = await course();
    await grant(team, at, ['see']);
    await grant(team, undefined, ['speak']);
    const leads = await group(['bob']);
    await grant(leads, { kind: 'group', id: team }, ['see', 'manage']);
    const remove = (token: string) =>
      request(server).delete(`/groups/${team}?reason=aufgeloest`).set(as(token));

    expect((await remove(tutor)).status).toBe(404);
    expect((await remove(alice)).status).toBe(403);
    const removed = await remove(bob);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true });
    expect((await request(server).get(`/groups/${team}`).set(as(dozent))).status).toBe(404);

    const id = new ObjectId(team);
    const grants = storage.db.collection('grants');
    expect(await grants.countDocuments({ $or: [{ groupId: id }, { 'scope.id': id }] })).toBe(0);
    expect((await request(server).get(`/rooms/${roomId}`).set(as(alice))).status).toBe(404);

    // The room tells that the group lost its rights there; the rest is at the group.
    const atRoom = (await tracesAt(roomId)).filter((event) => event.kind === 'grant-removed');
    expect(atRoom).toHaveLength(1);
    expect(atRoom[0]).toMatchObject({ createdBy: 'bob', reason: 'aufgeloest' });
    expect(String(atRoom[0]?.detail?.['groupId'])).toBe(team);
    const atGroup = await tracesAt(team);
    expect(atGroup.filter((event) => event.kind === 'grant-removed')).toHaveLength(2);
    expect(atGroup.at(-1)).toMatchObject({
      kind: 'group-deleted',
      createdBy: 'bob',
      detail: { name: 'Gruppe' },
      reason: 'aufgeloest',
    });
  });
});

describe('names to actor keys', () => {
  /** The names a token gets for these keys, ordered by key. */
  async function names(token: string, ids: string) {
    const answer = await request(server).get(`/actors?ids=${ids}`).set(as(token));
    return (answer.body as { actorId: string }[]).toSorted((a, b) =>
      a.actorId.localeCompare(b.actorId),
    );
  }

  it('names oneself and the members of every group one sees, everyone at the top', async () => {
    await Promise.all([
      touchActor(storage.db, { actorId: 'ida', label: 'Ida' }),
      touchActor(storage.db, { actorId: 'jan' }),
      touchActor(storage.db, { actorId: 'kim', label: 'Kim' }),
    ]);
    await group(['alice', 'ida', 'jan']);
    const kims = await group(['kim']);
    const leads = await group(['bob']);
    await grant(leads, { kind: 'group', id: kims }, ['see']);

    // kim is in no group alice sees, and ghost was never seen; jan has no name yet.
    expect(await names(alice, 'ida, jan,kim,ghost')).toEqual([
      { actorId: 'ida', label: 'Ida' },
      { actorId: 'jan' },
    ]);
    expect(await names(bob, 'kim,ida')).toEqual([{ actorId: 'kim', label: 'Kim' }]);
    expect(await names(dozent, 'kim,ida,ghost')).toEqual([
      { actorId: 'ida', label: 'Ida' },
      { actorId: 'kim', label: 'Kim' },
    ]);
  });

  it('refuses keys it cannot read', async () => {
    const ask = (query: string) => request(server).get(`/actors${query}`).set(as(alice));

    expect((await ask('')).status).toBe(400);
    expect((await ask('?ids=')).status).toBe(400);
    expect((await ask('?ids=ida,,jan')).status).toBe(400);
    expect((await ask('?ids=ida&ids=jan')).status).toBe(400);
  });
});

describe('rooms and workpieces under grants', () => {
  it('shows and lists a room only to whoever holds see there or everywhere', async () => {
    const { roomId, team, at } = await course();
    await grant(team, at, ['see']);
    const other = await room();
    const listed = async (token: string) =>
      (await request(server).get('/me/rooms').set(as(token))).body.map(
        (entry: { _id: string }) => entry._id,
      );

    expect(await listed(alice)).toContain(roomId);
    expect(await listed(alice)).not.toContain(other);
    expect(await listed(dozent)).toEqual(expect.arrayContaining([roomId, other]));
    expect((await request(server).get(`/rooms/${roomId}`).set(as(alice))).status).toBe(200);
    expect((await request(server).get(`/rooms/${roomId}`).set(as(bob))).status).toBe(404);
  });

  it('lets whoever manages a room change it, while creating it gave the dozent nothing extra', async () => {
    const { roomId, team, at } = await course();
    await grant(team, at, ['see']);
    const rename = (token: string) =>
      request(server)
        .patch(`/rooms/${roomId}`)
        .set(as(token))
        .send({ settings: { mode: 'sync' } });

    expect((await rename(tutor)).status).toBe(200);
    expect((await rename(alice)).status).toBe(403);
  });

  it('lists the workpieces a token sees, at them or through a room, all of them at the top', async () => {
    const { workpieceId, team, at } = await course();
    await grant(team, at, ['see']);
    const created = await request(server)
      .post('/workpieces')
      .set(as(dozent))
      .send({ name: 'Einzeln', contract: {} });
    const single = created.body._id as string;
    const readers = await group(['bob']);
    await grant(readers, { kind: 'workpiece', id: single }, ['see']);
    // Folded once, so the list has a state it must leave out.
    await storage.db.collection('workpieces').updateOne(
      { _id: new ObjectId(single) },
      {
        $set: { fold: { state: new Binary(Buffer.from([0, 0])), upToUpdateId: new ObjectId() } },
      },
    );
    const listed = async (token: string) =>
      (await request(server).get('/workpieces').set(as(token))).body as { _id: string }[];
    const ids = async (token: string) => (await listed(token)).map((entry) => entry._id);

    expect(await ids(alice)).toContain(workpieceId);
    expect(await ids(alice)).not.toContain(single);
    expect(await ids(bob)).toContain(single);
    expect(await ids(bob)).not.toContain(workpieceId);
    expect(await ids(dozent)).toEqual(expect.arrayContaining([workpieceId, single]));
    expect((await listed(bob)).find((entry) => entry._id === single)).not.toHaveProperty('fold');
  });

  it('creates a workpiece in a room with manage there, outside every room with manage everywhere', async () => {
    const { roomId } = await course();
    const create = (token: string, more: object) =>
      request(server)
        .post('/workpieces')
        .set(as(token))
        .send({ name: 'Neu', ...more });

    const made = await create(tutor, { roomId });
    expect(made.status).toBe(201);
    const inRoom = await request(server).get(`/rooms/${roomId}`).set(as(tutor));
    expect(inRoom.body.references).toContainEqual({ kind: 'workpiece', id: made.body._id });

    expect((await create(tutor, {})).status).toBe(403);
    expect((await create(dozent, {})).status).toBe(201);
    expect((await create(alice, { roomId })).status).toBe(404);
    expect((await create(tutor, { roomId: new ObjectId().toHexString() })).status).toBe(404);
    expect((await create(tutor, { roomId: 'kein-schluessel' })).status).toBe(400);
  });

  it('hands a workpiece into another room only with manage at both', async () => {
    const { workpieceId } = await course();
    const second = await room();
    const review = await group(['bob']);
    await grant(review, { kind: 'room', id: second }, ['see', 'manage']);
    const push = () =>
      request(server)
        .post(`/rooms/${second}/references`)
        .set(as(bob))
        .send({ kind: 'workpiece', id: workpieceId });

    // Unseen it stays unknown; seen but not managed it is not bob's to hand on.
    expect((await push()).status).toBe(404);
    await grant(review, { kind: 'workpiece', id: workpieceId }, ['see']);
    expect((await push()).status).toBe(403);
    await grant(review, { kind: 'workpiece', id: workpieceId }, ['see', 'manage']);
    expect((await push()).status).toBe(201);
  });

  it('keeps groups out of the references and points to the grants', async () => {
    const roomId = await room();
    const team = await group(['alice']);

    const pushed = await request(server)
      .post(`/rooms/${roomId}/references`)
      .set(as(dozent))
      .send({ kind: 'group', id: team });

    expect(pushed.status).toBe(400);
    expect(pushed.body.error).toContain('PUT /grants');
  });
});

describe('renaming and deleting rooms', () => {
  it('renames a room with manage there and leaves a trace, but none for the same name', async () => {
    const { roomId, team, at } = await course();
    await grant(team, at, ['see']);
    const rename = (token: string) =>
      request(server)
        .patch(`/rooms/${roomId}`)
        .set(as(token))
        .send({ name: 'Seminar', reason: 'neues Semester' });

    expect((await rename(bob)).status).toBe(404);
    expect((await rename(alice)).status).toBe(403);
    const renamed = await rename(tutor);
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Seminar');
    expect((await rename(tutor)).status).toBe(200);

    const traces = (await tracesAt(roomId)).filter((event) => event.kind === 'room-renamed');
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      createdBy: 'tutor',
      detail: { to: 'Seminar' },
      reason: 'neues Semester',
    });
  });

  it('takes name and settings at once and refuses a change with neither', async () => {
    const roomId = await room();
    const change = (sent: object) =>
      request(server).patch(`/rooms/${roomId}`).set(as(dozent)).send(sent);

    const both = await change({ name: 'Labor', settings: { mode: 'async' } });
    expect(both.body).toMatchObject({ name: 'Labor', settings: { mode: 'async' } });
    expect((await change({})).status).toBe(400);
    expect((await change({ name: '  ' })).status).toBe(400);
    expect((await change({ name: 7, settings: {} })).status).toBe(400);
  });

  it('deletes a room with manage there: its grants go, its workpieces stay', async () => {
    const { roomId, workpieceId, team, tutors, at } = await course();
    await grant(team, at, ['see']);
    const remove = (token: string) =>
      request(server).delete(`/rooms/${roomId}?reason=aufgeraeumt`).set(as(token));

    expect((await remove(bob)).status).toBe(404);
    expect((await remove(alice)).status).toBe(403);
    const removed = await remove(tutor);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true });
    expect((await remove(tutor)).status).toBe(404);

    const grants = storage.db.collection('grants');
    expect(await grants.countDocuments({ 'scope.id': new ObjectId(roomId) })).toBe(0);
    // The workpiece lives on; alice saw it only through the room, the dozent sees it from above.
    const show = (token: string) =>
      request(server).get(`/workpieces/${workpieceId}`).set(as(token));
    expect((await show(dozent)).status).toBe(200);
    expect((await show(alice)).status).toBe(404);

    // A trace for each grant that went, then one for the room, all with the why.
    const traces = await tracesAt(roomId);
    const gone = traces.filter((event) => event.kind === 'grant-removed');
    expect(gone.map((event) => String(event.detail?.['groupId'])).toSorted()).toEqual(
      [team, tutors].toSorted(),
    );
    expect(gone.every((event) => event.reason === 'aufgeraeumt')).toBe(true);
    expect(traces.at(-1)).toMatchObject({
      kind: 'room-deleted',
      createdBy: 'tutor',
      detail: { name: 'Übung' },
      reason: 'aufgeraeumt',
    });
  });
});

describe('tasks and comments under grants', () => {
  /** A class where the team may see, speak and plan in the room and the readers only see. */
  async function workroom() {
    const setting = await course();
    await grant(setting.team, setting.at, ['see', 'speak', 'plan']);
    const readers = await group(['erin']);
    await grant(readers, setting.at, ['see']);
    return { ...setting, anchor: { kind: 'workpiece', id: setting.workpieceId } };
  }
  const plan = (token: string, task: object) =>
    request(server)
      .post('/tasks')
      .set(as(token))
      .send({ kind: 'task', title: 'Entwurf', state: 'open', ...task });
  const move = (token: string, id: string, state: string) =>
    request(server).patch(`/tasks/${id}`).set(as(token)).send({ state });

  it('plans where plan holds, and without an anchor only with plan everywhere', async () => {
    const { anchor } = await workroom();

    expect((await plan(alice, { anchor })).status).toBe(201);
    expect((await plan(tokenFor('erin'), { anchor })).status).toBe(403);
    expect((await plan(bob, { anchor })).status).toBe(404);
    expect((await plan(alice, {})).status).toBe(403);
    expect((await plan(alice, { anchor, state: 'accepted' })).status).toBe(403);
    expect((await plan(dozent, {})).status).toBe(201);
  });

  it('lets whom a task is given move its state, but never into a decision', async () => {
    const { anchor } = await workroom();
    const readers = await group(['erin']);
    await grant(readers, { kind: 'workpiece', id: anchor.id }, ['see']);
    const made = await plan(dozent, { anchor, assignees: [{ kind: 'group', id: readers }] });
    const id = made.body._id as string;

    // erin only sees, but the task is given to her group.
    expect((await move(tokenFor('erin'), id, 'done')).status).toBe(200);
    expect((await move(tokenFor('erin'), id, 'accepted')).status).toBe(403);
    // alice plans in the room, which moves any state but a decision.
    expect((await move(alice, id, 'open')).status).toBe(200);
    expect((await move(alice, id, 'accepted')).status).toBe(403);
    expect((await move(tutor, id, 'accepted')).status).toBe(403);
    expect((await move(dozent, id, 'accepted')).status).toBe(200);
  });

  it('gives a task to a group only if it sees what the task is about, a person always', async () => {
    const { anchor } = await workroom();
    const outsiders = await group(['frank']);
    const made = await plan(dozent, { anchor });
    const give = (assignee: object) =>
      request(server)
        .post(`/tasks/${made.body._id as string}/assignees`)
        .set(as(dozent))
        .send(assignee);

    expect((await give({ kind: 'group', id: outsiders })).status).toBe(409);
    expect(
      (await plan(dozent, { anchor, assignees: [{ kind: 'group', id: outsiders }] })).status,
    ).toBe(409);
    // A person is not asked, as the service cannot see whether their token stands at the top.
    expect((await give({ kind: 'actor', id: 'frank' })).status).toBe(201);

    await grant(outsiders, { kind: 'workpiece', id: anchor.id }, ['see']);
    expect((await give({ kind: 'group', id: outsiders })).status).toBe(201);
  });

  it('shows a task to whom it is given, even without any grant', async () => {
    const { anchor } = await workroom();
    const made = await plan(dozent, { anchor, assignees: [{ kind: 'actor', id: 'gina' }] });
    const show = (token: string) =>
      request(server)
        .get(`/tasks/${made.body._id as string}`)
        .set(as(token));

    expect((await show(tokenFor('gina'))).status).toBe(200);
    expect((await show(bob)).status).toBe(404);
  });

  it('lets whoever may speak say something, and only decide set a decision', async () => {
    const { anchor } = await workroom();
    const say = (token: string, more: object = {}) =>
      request(server)
        .post('/comments')
        .set(as(token))
        .send({ kind: 'comment', anchor, body: { text: 'Kardinalität?' }, ...more });
    const mark = (token: string, id: string, state: string) =>
      request(server).patch(`/comments/${id}`).set(as(token)).send({ state });

    const said = await say(alice);
    expect(said.status).toBe(201);
    expect((await say(tokenFor('erin'))).status).toBe(403);
    expect((await say(alice, { state: 'accepted' })).status).toBe(403);

    const id = said.body._id as string;
    expect((await mark(alice, id, 'read')).status).toBe(200);
    expect((await mark(tokenFor('erin'), id, 'read')).status).toBe(403);
    expect((await mark(alice, id, 'accepted')).status).toBe(403);
    expect((await mark(tutor, id, 'accepted')).status).toBe(403);
    expect((await mark(dozent, id, 'accepted')).status).toBe(200);
  });
});

describe('changing and deleting comments', () => {
  /** A comment alice said in a room where her team may speak and the tutors manage. */
  async function said() {
    const setting = await course();
    await grant(setting.team, setting.at, ['see', 'speak']);
    const mates = await group(['carol']);
    await grant(mates, setting.at, ['see', 'speak']);
    const anchor = { kind: 'workpiece', id: setting.workpieceId };
    const comment = await request(server)
      .post('/comments')
      .set(as(alice))
      .send({ kind: 'comment', anchor, body: { text: 'Kardinalitat' } });
    return { ...setting, anchor, id: comment.body._id as string };
  }
  const change = (token: string, id: string, sent: object) =>
    request(server).patch(`/comments/${id}`).set(as(token)).send(sent);
  const remove = (token: string, id: string) =>
    request(server).delete(`/comments/${id}`).set(as(token));
  const traces = async (id: string, kind: string) =>
    (
      await request(server)
        .get('/events')
        .query({ anchorKind: 'comment', anchorId: id, kind })
        .set(as(dozent))
    ).body as { createdBy: string; detail?: object }[];

  it('lets the author change the words and keeps only who did it, never the old words', async () => {
    const { id } = await said();

    const changed = await change(alice, id, {
      body: { text: 'Kardinalität' },
      reason: 'Tippfehler',
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ body: { text: 'Kardinalität' } });
    expect(changed.body.editedAt).toBeDefined();

    // The same words again change nothing and leave no second trace.
    await change(alice, id, { body: { text: 'Kardinalität' } });
    const edits = await traces(id, 'comment-edited');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ createdBy: 'alice' });
    expect(edits[0]).not.toHaveProperty('detail');
  });

  it('keeps the words from anyone else who may speak, and gives them to whoever manages', async () => {
    const { id } = await said();

    expect((await change(tokenFor('carol'), id, { body: { text: 'fremd' } })).status).toBe(403);
    expect((await change(tutor, id, { body: { text: 'moderiert' } })).status).toBe(200);
  });

  it('takes the words from the author once speak is gone', async () => {
    const { id, team, roomId } = await said();
    await grant(team, { kind: 'room', id: roomId }, ['see']);

    expect((await change(alice, id, { body: { text: 'zu spät' } })).status).toBe(403);
    expect((await remove(alice, id)).status).toBe(403);
  });

  it('deletes the words for good and leaves a shell, so the answers keep their thread', async () => {
    const { id, anchor } = await said();
    const answer = await request(server)
      .post('/comments')
      .set(as(tokenFor('carol')))
      .send({ kind: 'comment', anchor, parentId: id, body: { text: 'Antwort' } });

    const deleted = await remove(alice, id);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ body: {}, createdBy: 'alice', deletedBy: 'alice' });
    expect(deleted.body.deletedAt).toBeDefined();

    const thread = await request(server)
      .get('/comments')
      .query({ anchorKind: 'workpiece', anchorId: anchor.id, parentId: id })
      .set(as(alice));
    expect(thread.body.map((entry: { _id: string }) => entry._id)).toEqual([answer.body._id]);

    // Deleting twice is no mistake and leaves no second trace; a shell takes no change.
    expect((await remove(alice, id)).status).toBe(200);
    expect(await traces(id, 'comment-deleted')).toHaveLength(1);
    expect((await change(alice, id, { body: { text: 'wieder' } })).status).toBe(409);
    expect((await change(tutor, id, { state: 'read' })).status).toBe(409);
  });

  it('refuses a change without words or state, and words that are no object', async () => {
    const { id } = await said();

    expect((await change(alice, id, {})).status).toBe(400);
    expect((await change(alice, id, { body: 'Text' })).status).toBe(400);
    expect((await remove(bob, id)).status).toBe(404);
  });
});

describe('answers and subtasks stay with what they are about', () => {
  it('keeps an answer on the thing of its comment, at any unit of it', async () => {
    const { team, at, roomId, workpieceId } = await course();
    await grant(team, at, ['see', 'speak']);
    const other = await workpieceIn(roomId);
    const say = (anchor: object, parentId?: string) =>
      request(server)
        .post('/comments')
        .set(as(alice))
        .send({
          kind: 'comment',
          anchor,
          body: {},
          ...(parentId === undefined ? {} : { parentId }),
        });

    const first = await say({ kind: 'workpiece', id: workpieceId, unit: 'e1' });
    const id = first.body._id as string;

    expect((await say({ kind: 'workpiece', id: workpieceId, unit: 'e2' }, id)).status).toBe(201);
    expect((await say({ kind: 'workpiece', id: workpieceId }, id)).status).toBe(201);
    expect((await say({ kind: 'workpiece', id: other }, id)).status).toBe(400);
    expect((await say(at, id)).status).toBe(400);
  });

  it('shows a subtask on a hidden thing not to whom only its parent is given', async () => {
    const { workpieceId } = await course();
    const plan = (task: object) =>
      request(server)
        .post('/tasks')
        .set(as(dozent))
        .send({ kind: 'task', title: 'Teil', state: 'open', ...task });
    const parent = await plan({ assignees: [{ kind: 'actor', id: 'gina' }] });
    const parentId = parent.body._id as string;
    const hidden = await plan({ parentId, anchor: { kind: 'workpiece', id: workpieceId } });
    const plain = await plan({ parentId });
    const show = (id: string) =>
      request(server)
        .get(`/tasks/${id}`)
        .set(as(tokenFor('gina')));

    expect((await show(parentId)).status).toBe(200);
    expect((await show(plain.body._id as string)).status).toBe(200);
    expect((await show(hidden.body._id as string)).status).toBe(404);
  });
});
