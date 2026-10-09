import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import type { ActorRecord } from '../../src/db/collections/actors.ts';
import { createComment } from '../../src/db/collections/comments.ts';
import { recordEvent } from '../../src/db/collections/events.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createWorkpieceHub } from '../../src/realtime/hub.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_names_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const secret = 'names-secret';
const logger = pino({ level: 'silent' });

const tokenFor = (subject: string, claims: object = {}) =>
  jwt.sign({ sub: subject, ...claims }, secret, { algorithm: 'HS256' });
// Alice and frank are at the top, the others in one of two teams of the same room.
const alice = tokenFor('alice', { globalRole: 'ADMIN', name: 'Alice' });
const frank = tokenFor('frank', { globalRole: 'ADMIN', name: 'Frank' });
const carol = tokenFor('carol', { name: 'Carol' });
const dave = tokenFor('dave', { name: 'Dave' });
const erin = tokenFor('erin', { name: 'Erin' });

let storage: Storage;
let server: ReturnType<typeof createServer>;

const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const send = (token: string, path: string, body: object) =>
  request(server).post(path).set(as(token)).send(body);
/** Any request at all, so the person has used the service once. */
const visit = (token: string) => request(server).get('/me/rooms').set(as(token));
const onWorkpiece = (id: string) => ({ kind: 'workpiece', id });

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const hub = createWorkpieceHub({ db: storage.db, logger });
  server = createServer({
    logger,
    api: createApi({
      db: storage.db,
      hub,
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
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

/** A room with one workpiece and two teams that each see it, but not each other. */
async function twoTeams(): Promise<{
  roomId: string;
  workpieceId: string;
  teamA: string;
  teamB: string;
}> {
  const room = await send(alice, '/rooms', { name: 'Seminar' });
  const roomId = room.body._id as string;
  const workpiece = await send(alice, '/workpieces', { name: 'Modell', roomId });
  const teamA = await send(alice, '/groups', { name: 'Team A', members: ['carol'] });
  const teamB = await send(alice, '/groups', { name: 'Team B', members: ['dave'] });

  for (const team of [teamA, teamB]) {
    // eslint-disable-next-line no-await-in-loop
    await request(server)
      .put('/grants')
      .set(as(alice))
      .send({
        groupId: team.body._id as string,
        scope: { kind: 'room', id: roomId },
        rights: ['see', 'speak', 'plan'],
      });
  }

  return {
    roomId,
    workpieceId: workpiece.body._id as string,
    teamA: teamA.body._id as string,
    teamB: teamB.body._id as string,
  };
}

describe('keeping the name', () => {
  it('keeps the name of whoever only uses REST, and follows a changed one', async () => {
    const actors = storage.db.collection<ActorRecord>('actors');

    await visit(tokenFor('gina', { name: 'Gina' }));
    expect(await actors.findOne({ _id: 'gina' })).toEqual({ _id: 'gina', label: 'Gina' });

    await visit(tokenFor('gina', { name: 'Gina Neu' }));
    expect((await actors.findOne({ _id: 'gina' }))?.label).toBe('Gina Neu');
  });
});

describe('names in the answers', () => {
  it('names whoever wrote a comment, also to another team in the same room', async () => {
    const { workpieceId } = await twoTeams();

    const said = await send(dave, '/comments', {
      kind: 'comment',
      anchor: onWorkpiece(workpieceId),
      body: {},
    });
    expect(said.body.names).toEqual({ dave: 'Dave' });

    const read = await request(server)
      .get('/comments')
      .query({ anchorKind: 'workpiece', anchorId: workpieceId })
      .set(as(carol));
    expect(read.body[0].names).toEqual({ dave: 'Dave' });

    // Asked by key alone, carol still gets only the members of groups she sees.
    const looked = await request(server).get('/actors').query({ ids: 'dave' }).set(as(carol));
    expect(looked.body).toEqual([]);
  });

  it('names the members of a group, and in member-added the one taken in', async () => {
    const { teamA } = await twoTeams();
    await Promise.all([visit(carol), visit(erin)]);

    const added = await send(alice, `/groups/${teamA}/members`, { actorId: 'erin' });
    expect(added.body.names).toEqual({ alice: 'Alice', carol: 'Carol', erin: 'Erin' });

    const events = await request(server)
      .get('/events')
      .query({ anchorKind: 'group', anchorId: teamA, kind: 'member-added' })
      .set(as(alice));
    expect(events.body[0]).toMatchObject({
      detail: { actorId: 'erin' },
      names: { alice: 'Alice', erin: 'Erin' },
    });
  });

  it('names a person among the assignees, and in assignee-added the one it was given to', async () => {
    const { workpieceId } = await twoTeams();
    await visit(dave);

    const task = await send(carol, '/tasks', {
      kind: 'task',
      title: 'Entwurf',
      state: 'offen',
      anchor: onWorkpiece(workpieceId),
    });
    const id = task.body._id as string;
    const given = await send(carol, `/tasks/${id}/assignees`, { kind: 'actor', id: 'dave' });
    expect(given.body.names).toEqual({ carol: 'Carol', dave: 'Dave' });

    const events = await request(server)
      .get('/events')
      .query({ anchorKind: 'task', anchorId: id, kind: 'assignee-added' })
      .set(as(carol));
    expect(events.body[0].names).toEqual({ carol: 'Carol', dave: 'Dave' });
  });

  it('never reads a key out of a detail the tool wrote', async () => {
    const { roomId } = await twoTeams();
    await visit(dave);

    const told = await send(carol, '/events', {
      kind: 'visit',
      anchor: { kind: 'room', id: roomId },
      detail: { actorId: 'dave', kind: 'actor', id: 'dave' },
    });

    expect(told.body.names).toEqual({ carol: 'Carol' });
  });

  it('leaves out a key without a name, and names altogether when none is known', async () => {
    const { workpieceId } = await twoTeams();
    await visit(carol);

    const group = await send(alice, '/groups', { name: 'Gemischt', members: ['carol', 'ghost'] });
    expect(group.body.names).toEqual({ alice: 'Alice', carol: 'Carol' });

    const comment = await createComment(storage.db, {
      kind: 'comment',
      anchor: { kind: 'workpiece', id: new ObjectId(workpieceId) },
      createdBy: 'ghost',
      body: {},
    });
    const read = await request(server).get(`/comments/${comment._id.toHexString()}`).set(as(alice));
    expect(read.body.createdBy).toBe('ghost');
    expect(read.body).not.toHaveProperty('names');
  });
});

describe('who was last active where', () => {
  type Row = { actorId: string; at: string; kind: string; names?: object };
  const activity = async (path: string, token: string) =>
    (await request(server).get(path).set(as(token))).body as Row[];

  it('gives per person the newest trace, newest first, only from what one sees', async () => {
    const { roomId, workpieceId, teamB } = await twoTeams();
    await send(carol, '/events', { kind: 'visit', anchor: { kind: 'room', id: roomId } });
    await send(dave, '/comments', { kind: 'comment', anchor: onWorkpiece(workpieceId), body: {} });
    await send(carol, '/comments', { kind: 'comment', anchor: onWorkpiece(workpieceId), body: {} });
    // In team B, which carol does not see.
    await send(frank, `/groups/${teamB}/members`, { actorId: 'erin' });
    // work-lost names the other side, who was not there when it was written.
    await recordEvent(storage.db, {
      kind: 'work-lost',
      createdBy: 'ghost',
      anchor: { kind: 'workpiece', id: new ObjectId(workpieceId) },
      affects: ['carol'],
    });

    const forCarol = await activity(`/rooms/${roomId}/activity`, carol);
    expect(forCarol.map((row) => row.actorId)).toEqual(['carol', 'dave', 'alice']);
    expect(forCarol[0]).toMatchObject({
      actorId: 'carol',
      kind: 'comment-created',
      names: { carol: 'Carol' },
    });
    expect(Date.parse(forCarol[0]?.at ?? '')).not.toBeNaN();

    // At the top every group of the room is in view.
    const forAlice = await activity(`/rooms/${roomId}/activity`, alice);
    expect(forAlice.map((row) => row.actorId)).toEqual(['frank', 'carol', 'dave', 'alice']);

    // At the workpiece only what hangs on it, its comments included.
    const atWorkpiece = await activity(`/workpieces/${workpieceId}/activity`, carol);
    expect(atWorkpiece.map((row) => row.actorId)).toEqual(['carol', 'dave']);
  });

  it('answers 404 to whoever does not see the room or workpiece', async () => {
    const { roomId, workpieceId } = await twoTeams();
    const outsider = tokenFor('outsider', { name: 'Outsider' });

    expect((await request(server).get(`/rooms/${roomId}/activity`).set(as(outsider))).status).toBe(
      404,
    );
    expect(
      (await request(server).get(`/workpieces/${workpieceId}/activity`).set(as(outsider))).status,
    ).toBe(404);
  });
});
