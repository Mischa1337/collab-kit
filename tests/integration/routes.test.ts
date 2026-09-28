import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createComment } from '../../src/db/collections/comments.ts';
import { createTask, type NewTask } from '../../src/db/collections/tasks.ts';
import { appendUpdate } from '../../src/db/collections/updates.ts';
import { foldState } from '../../src/db/collections/workpieces.ts';
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
    request(server).post(`/rooms/${roomId}/references`).set(as(alice)).send(entry);

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

  it('checks the token before it reads the body', async () => {
    const malformed = (token?: string) => {
      const sent = request(server).post('/rooms').set('Content-Type', 'application/json');
      return (token === undefined ? sent : sent.set(as(token))).send('{nope');
    };

    expect((await malformed()).status).toBe(401);
    expect((await malformed(alice)).status).toBe(400);
  });
});

describe('setting a room up', () => {
  it('walks the whole way and ends at an openable workpiece', async () => {
    const { roomId, workpieceId } = await setUp();

    const room = await request(server).get(`/rooms/${roomId}`).set(as(bob));
    expect(room.status).toBe(200);
    expect(room.body.references).toHaveLength(2);

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

  it('takes a reference out again, named in the query', async () => {
    const { roomId, groupId } = await setUp();
    const unnamed = await request(server).delete(`/rooms/${roomId}/references`).set(as(alice));
    expect(unnamed.status).toBe(400);

    const removed = await request(server)
      .delete(`/rooms/${roomId}/references`)
      .query({ kind: 'group', id: groupId })
      .set(as(alice));

    expect(removed.status).toBe(200);
    expect(removed.body.references).toEqual([{ kind: 'workpiece', id: expect.any(String) }]);
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
      .post(`/rooms/${roomId}/references`)
      .set(as(bob))
      .send({ kind: 'group', id: '000000000000000000000000' });

    expect(pushed.status).toBe(403);
  });

  it('lets nobody put what they may not see into a room of their own', async () => {
    const { workpieceId } = await setUp();
    const carol = tokenFor('carol');
    const room = await request(server).post('/rooms').set(as(carol)).send({ name: 'Eigen' });

    const pushed = await request(server)
      .post(`/rooms/${room.body._id as string}/references`)
      .set(as(carol))
      .send({ kind: 'workpiece', id: workpieceId });

    expect(pushed.status).toBe(404);
  });

  it('takes an id only as text, so it never reaches the database as an operator', async () => {
    const carol = tokenFor('carol');
    const room = await request(server).post('/rooms').set(as(carol)).send({ name: 'Eigen' });
    const statuses = async (id: unknown) => {
      const pushed = await request(server)
        .post(`/rooms/${room.body._id as string}/references`)
        .set(as(carol))
        .send({ kind: 'workpiece', id });
      const traced = await request(server)
        .post('/events')
        .set(as(carol))
        .send({ kind: 'note', anchor: { kind: 'workpiece', id } });
      return [pushed.status, traced.status];
    };

    // As an operator it would have matched the traces at every workpiece of the service.
    expect(await statuses({ $exists: true })).toEqual([400, 400]);
    expect(await statuses(42)).toEqual([400, 400]);
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

describe('where a client starts', () => {
  it('lists the rooms a token may see, and no other', async () => {
    const { roomId } = await setUp();
    const empty = await request(server).post('/rooms').set(as(alice)).send({ name: 'Leer' });
    const emptyId = empty.body._id as string;
    const listed = async (token: string) => {
      const rooms = await request(server).get('/me/rooms').set(as(token));
      return rooms.body.map((room: { _id: string }) => room._id);
    };

    expect(await listed(alice)).toEqual(expect.arrayContaining([roomId, emptyId]));
    expect(await listed(bob)).toContain(roomId);
    expect(await listed(bob)).not.toContain(emptyId);
    expect(await listed(tokenFor('carol'))).not.toContain(roomId);
  });

  it('reads an actor key in a body as the token does, numbers included', async () => {
    const { groupId } = await setUp();

    await request(server).post(`/groups/${groupId}/members`).set(as(alice)).send({ actorId: 42 });
    const groups = await request(server)
      .get('/me/groups')
      .set(as(tokenFor('42')));

    expect(groups.body.map((group: { _id: string }) => group._id)).toContain(groupId);
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

  it('refuses settings that are no object, also when creating', async () => {
    const room = { name: 'Laut', settings: 'laut' };
    const group = { name: 'Laut', settings: 'laut', members: [] };

    expect((await request(server).post('/rooms').set(as(alice)).send(room)).status).toBe(400);
    expect((await request(server).post('/groups').set(as(alice)).send(group)).status).toBe(400);
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
    expect(first.body.createdBy).toBe('alice');

    await request(server)
      .post('/events')
      .set(as(bob))
      .send({ kind: 'visit', anchor: { kind: 'room', id: roomId } });

    const since = await request(server)
      .get(`/rooms/${roomId}/events`)
      .query({ since: first.body._id as string })
      .set(as(bob));

    expect(since.body).toHaveLength(1);
    expect(since.body[0].createdBy).toBe('bob');
  });

  it('shows what one person did in the room', async () => {
    const { roomId } = await setUp();
    await request(server)
      .post('/events')
      .set(as(bob))
      .send({ kind: 'visit', anchor: { kind: 'room', id: roomId } });

    const bobs = await request(server)
      .get(`/rooms/${roomId}/events`)
      .query({ createdBy: 'bob' })
      .set(as(alice));

    expect(bobs.body.map((event: { kind: string }) => event.kind)).toEqual(['visit']);
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

  it('keeps out a trace of a made-up kind that borrows the id of the room', async () => {
    const { roomId } = await setUp();
    const carol = tokenFor('carol');

    const planted = await request(server)
      .post('/events')
      .set(as(carol))
      .send({ kind: 'planted', anchor: { kind: 'made-up', id: roomId } });
    expect(planted.status).toBe(201);

    const events = await request(server).get(`/rooms/${roomId}/events`).set(as(bob));

    expect(events.body.map((event: { kind: string }) => event.kind)).not.toContain('planted');
  });

  it('shows who joined a group of the room only to whoever may see that group', async () => {
    const { roomId, groupId } = await setUp();
    const carol = tokenFor('carol');
    const others = await request(server)
      .post('/groups')
      .set(as(alice))
      .send({ name: 'Andere', members: ['carol'] });
    await request(server)
      .post(`/rooms/${roomId}/references`)
      .set(as(alice))
      .send({ kind: 'group', id: others.body._id as string });

    const joinedAt = async (token: string) => {
      const events = await request(server)
        .get(`/rooms/${roomId}/events`)
        .query({ kind: 'member-added' })
        .set(as(token));
      return events.body.map((event: { anchor: { id: string } }) => event.anchor.id);
    };

    expect(await joinedAt(bob)).toContain(groupId);
    expect(await joinedAt(carol)).not.toContain(groupId);
  });

  it('shows who joined a group to its members and to nobody else', async () => {
    const { groupId } = await setUp();
    const carol = tokenFor('carol');
    const query = { anchorKind: 'group', anchorId: groupId, kind: 'member-added' };

    const seen = await request(server).get('/events').query(query).set(as(bob));
    expect(seen.status).toBe(200);
    expect(seen.body).toHaveLength(2);

    expect((await request(server).get('/events').query(query).set(as(carol))).status).toBe(404);
  });

  it('shows the traces at a comment only to whoever may see what it is about', async () => {
    const { workpieceId } = await setUp();
    const comment = await createComment(storage.db, {
      kind: 'feedback',
      anchor: { kind: 'workpiece', id: new ObjectId(workpieceId) },
      createdBy: 'alice',
      body: {},
    });
    const query = { anchorKind: 'comment', anchorId: comment._id.toHexString() };

    expect((await request(server).get('/events').query(query).set(as(bob))).status).toBe(200);
    expect(
      (
        await request(server)
          .get('/events')
          .query(query)
          .set(as(tokenFor('carol')))
      ).status,
    ).toBe(404);
  });

  it('refuses a trace on a workpiece the actor may not see, but not to its creator', async () => {
    const loose = await request(server).post('/workpieces').set(as(alice)).send({ name: 'Allein' });
    const trace = { kind: 'note', anchor: { kind: 'workpiece', id: loose.body._id as string } };

    expect((await request(server).post('/events').set(as(bob)).send(trace)).status).toBe(404);
    expect((await request(server).post('/events').set(as(alice)).send(trace)).status).toBe(201);
  });
});

/** An anchor of a kind the tool made up, so nothing but what a test reports sits at it. */
const board = () => ({ kind: 'board', id: `b-${new ObjectId().toHexString()}` });

describe('traces and marks', () => {
  const readAt = (anchor: { kind: string; id: string }, query: Record<string, string>) =>
    request(server)
      .get('/events')
      .query({ anchorKind: anchor.kind, anchorId: anchor.id, ...query })
      .set(as(alice));

  it('keeps the kinds the service writes out of what a tool may report', async () => {
    const { groupId } = await setUp();
    const report = (kind: string) =>
      request(server)
        .post('/events')
        .set(as(bob))
        .send({ kind, anchor: { kind: 'group', id: groupId }, detail: { actorId: 'mallory' } });

    expect((await report('member-added')).status).toBe(400);
    expect((await report('checkpoint')).status).toBe(400);
    expect((await report('visit')).status).toBe(201);
  });

  it('pages back through a history with before, and cuts a window with both', async () => {
    const anchor = board();
    const report = async (kind: string) => {
      const event = await request(server).post('/events').set(as(alice)).send({ kind, anchor });
      return event.body._id as string;
    };
    const one = await report('one');
    const two = await report('two');
    const three = await report('three');
    const kinds = async (query: Record<string, string>) =>
      (await readAt(anchor, query)).body.map((event: { kind: string }) => event.kind);

    expect(await kinds({ limit: '2' })).toEqual(['three', 'two']);
    expect(await kinds({ before: two, limit: '2' })).toEqual(['one']);
    expect(await kinds({ since: one, before: three })).toEqual(['two']);
  });

  it('refuses a cut it cannot read instead of turning the stream around', async () => {
    const anchor = board();

    expect((await readAt(anchor, { since: 'undefined' })).status).toBe(400);
    expect((await readAt(anchor, { before: 'undefined' })).status).toBe(400);
  });

  it('filters by an actor key exactly as the token gave it', async () => {
    const anchor = board();
    await request(server)
      .post('/events')
      .set(as(tokenFor('u-17 ')))
      .send({ kind: 'visit', anchor });

    expect((await readAt(anchor, { createdBy: 'u-17 ' })).body).toHaveLength(1);
  });
});

describe('a value that was sent but cannot be used', () => {
  it('is refused instead of dropped unnoticed, in queries and in bodies', async () => {
    const { roomId, workpieceId } = await setUp();
    const anchor = board();
    const read = (path: string, query: Record<string, string>) =>
      request(server).get(path).query(query).set(as(bob));
    const send = (path: string, body: object) => request(server).post(path).set(as(bob)).send(body);
    const at = { anchorKind: anchor.kind, anchorId: anchor.id };

    expect((await read(`/rooms/${roomId}/events`, { since: 'undefined' })).status).toBe(400);
    expect((await read(`/rooms/${roomId}/events`, { limit: '0' })).status).toBe(400);
    expect((await read(`/workpieces/${workpieceId}/updates`, { since: 'x' })).status).toBe(400);
    expect((await read('/events', { ...at, scope: 'wohle' })).status).toBe(400);
    expect((await read('/events', { ...at, limit: 'viele' })).status).toBe(400);
    expect((await send('/events', { kind: 'note', anchor, reason: 42 })).status).toBe(400);
    expect((await send('/events', { kind: 'note', anchor, detail: 'frei' })).status).toBe(400);
    expect((await send(`/workpieces/${workpieceId}/checkpoints`, { reason: 42 })).status).toBe(400);

    const comment = { kind: 'comment', anchor, body: {} };
    expect((await send('/comments', { ...comment, parentId: 'x' })).status).toBe(400);
    expect((await send('/comments', { ...comment, state: 42 })).status).toBe(400);
    expect((await read('/comments', { ...at, since: 'undefined' })).status).toBe(400);
    expect((await read('/comments', { ...at, parentId: 'keiner' })).status).toBe(400);
  });

  it('takes a unit only as text, in a body as in a query', async () => {
    const anchor = board();
    const at = { anchorKind: anchor.kind, anchorId: anchor.id };
    const say = (unit: unknown) =>
      request(server)
        .post('/comments')
        .set(as(bob))
        .send({ kind: 'comment', anchor: { ...anchor, unit }, body: {} });
    const read = (query: Record<string, string | string[]>) =>
      request(server).get('/comments').query(query).set(as(bob));

    // An object would never be found again: a query sends text, MongoDB compares keys in order.
    expect((await say({ row: 4 })).status).toBe(400);
    expect((await say(42)).status).toBe(400);
    expect((await say(null)).status).toBe(400);
    expect((await say('row-4')).status).toBe(201);
    expect((await read({ ...at, unit: ['row-4', 'row-5'] })).status).toBe(400);
    expect((await read({ ...at, unit: 'row-4', scope: 'whole' })).status).toBe(400);
    expect((await read({ ...at, unit: 'row-4' })).body).toHaveLength(1);

    const trace = { kind: 'note', anchor: { ...anchor, unit: { row: 4 } } };
    expect((await request(server).post('/events').set(as(bob)).send(trace)).status).toBe(400);
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
      createdBy: 'bob',
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

  it('tells of each change by its size and hands the chain out in pieces', async () => {
    const { workpieceId } = await setUp();
    const id = new ObjectId(workpieceId);
    const change = (size: number) =>
      appendUpdate(storage.db, { workpieceId: id, bytes: new Uint8Array(size), createdBy: 'bob' });
    await change(3);
    const second = await change(5);
    await change(7);
    const sizes = async (query: Record<string, string>) => {
      const updates = await request(server)
        .get(`/workpieces/${workpieceId}/updates`)
        .query(query)
        .set(as(bob));
      return updates.body.map((update: { bytes: number }) => update.bytes);
    };

    expect(await sizes({})).toEqual([3, 5, 7]);
    expect(await sizes({ limit: '2' })).toEqual([3, 5]);
    expect(await sizes({ since: second._id.toHexString(), limit: '2' })).toEqual([7]);
  });
});

describe('a workpiece as a thing', () => {
  it('describes it without the folded state, which belongs to loading', async () => {
    const { workpieceId } = await setUp();
    const id = new ObjectId(workpieceId);
    await foldState(storage.db, {
      workpieceId: id,
      state: new Uint8Array(8),
      upToUpdateId: new ObjectId(),
    });

    const described = await request(server).get(`/workpieces/${workpieceId}`).set(as(bob));

    expect(described.body).toEqual({
      _id: workpieceId,
      name: 'Entwurf',
      contract: { kind: 'sql-skript' },
      createdAt: expect.any(String),
      createdBy: 'alice',
    });
  });

  it('refuses a contract that is no object', async () => {
    const refused = await request(server)
      .post('/workpieces')
      .set(as(alice))
      .send({ name: 'Entwurf', contract: 'sql' });

    expect(refused.status).toBe(400);
  });
});

/** An anchor at a workpiece, at one place in it when a unit is given. */
const onWorkpiece = (workpieceId: string, unit?: string) => ({
  kind: 'workpiece',
  id: workpieceId,
  ...(unit === undefined ? {} : { unit }),
});

describe('saying something about a thing', () => {
  const say = (token: string, comment: object) =>
    request(server).post('/comments').set(as(token)).send(comment);
  const texts = async (workpieceId: string, query: Record<string, string>) => {
    const found = await request(server)
      .get('/comments')
      .query({ anchorKind: 'workpiece', anchorId: workpieceId, ...query })
      .set(as(alice));
    return found.body.map((comment: { body: { text: string } }) => comment.body.text);
  };

  /** eins by bob, zwei as the answer to it, drei at one place; gives the key of eins. */
  const conversation = async (workpieceId: string) => {
    const first = await say(bob, {
      kind: 'comment',
      anchor: onWorkpiece(workpieceId),
      body: { text: 'eins' },
    });
    const firstId = first.body._id as string;
    await say(alice, {
      kind: 'comment',
      anchor: onWorkpiece(workpieceId),
      parentId: firstId,
      body: { text: 'zwei' },
    });
    await say(alice, {
      kind: 'comment',
      anchor: onWorkpiece(workpieceId, 'statement-3'),
      body: { text: 'drei' },
    });
    return firstId;
  };

  it('takes who said it from the token and shows it to whoever may see the thing', async () => {
    const { workpieceId } = await setUp();

    const said = await say(bob, {
      kind: 'feedback',
      anchor: onWorkpiece(workpieceId),
      body: { text: 'zu lang' },
      createdBy: 'alice',
    });
    expect(said.status).toBe(201);
    expect(said.body.createdBy).toBe('bob');

    const path = `/comments/${said.body._id as string}`;
    expect((await request(server).get(path).set(as(alice))).body.body).toEqual({ text: 'zu lang' });
    expect(
      (
        await request(server)
          .get(path)
          .set(as(tokenFor('carol')))
      ).status,
    ).toBe(404);
  });

  it('refuses to say something about what the actor may not see', async () => {
    const { workpieceId } = await setUp();
    const comment = { kind: 'comment', anchor: onWorkpiece(workpieceId), body: {} };

    expect((await say(tokenFor('carol'), comment)).status).toBe(404);
  });

  it('points only at comments that exist, so no chain can close into a circle', async () => {
    const { workpieceId } = await setUp();
    // Keys can be guessed ahead; one not yet written would let two comments point at each other.
    const unwritten = new ObjectId().toHexString();

    const onIt = await say(bob, {
      kind: 'reaction',
      anchor: { kind: 'comment', id: unwritten },
      body: {},
    });
    const answering = await say(bob, {
      kind: 'comment',
      anchor: onWorkpiece(workpieceId),
      parentId: unwritten,
      body: {},
    });

    expect(onIt.status).toBe(404);
    expect(answering.status).toBe(404);
  });

  it('gives one place, the thing alone, the starts of the threads or one thread', async () => {
    const { workpieceId } = await setUp();
    const firstId = await conversation(workpieceId);

    expect(await texts(workpieceId, {})).toEqual(['eins', 'zwei', 'drei']);
    expect(await texts(workpieceId, { unit: 'statement-3' })).toEqual(['drei']);
    expect(await texts(workpieceId, { scope: 'whole' })).toEqual(['eins', 'zwei']);
    expect(await texts(workpieceId, { parentId: 'none' })).toEqual(['eins', 'drei']);
    expect(await texts(workpieceId, { parentId: firstId })).toEqual(['zwei']);
  });

  it('gives only what came after since, and only what one person said', async () => {
    const { workpieceId } = await setUp();
    const firstId = await conversation(workpieceId);

    expect(await texts(workpieceId, { since: firstId })).toEqual(['zwei', 'drei']);
    expect(await texts(workpieceId, { createdBy: 'bob' })).toEqual(['eins']);
  });

  it('keeps what is said about a thing from whoever may not see it', async () => {
    const { workpieceId } = await setUp();
    const found = await request(server)
      .get('/comments')
      .query({ anchorKind: 'workpiece', anchorId: workpieceId })
      .set(as(tokenFor('carol')));

    expect(found.status).toBe(404);
  });

  it('lets whoever may see it move the state, and keeps who and why', async () => {
    const { workpieceId } = await setUp();
    const said = await say(alice, {
      kind: 'feedback',
      anchor: onWorkpiece(workpieceId),
      body: {},
      state: 'offen',
    });
    const id = said.body._id as string;
    const mark = (token: string, change: object) =>
      request(server).patch(`/comments/${id}`).set(as(token)).send(change);

    const moved = await mark(bob, { state: 'umgesetzt', reason: 'im Entwurf nachgezogen' });
    expect(moved.status).toBe(200);
    expect(moved.body.state).toBe('umgesetzt');

    const traces = await request(server)
      .get('/events')
      .query({ anchorKind: 'comment', anchorId: id })
      .set(as(alice));
    expect(traces.body).toEqual([
      expect.objectContaining({
        kind: 'comment-state',
        createdBy: 'bob',
        reason: 'im Entwurf nachgezogen',
      }),
    ]);

    expect((await mark(bob, {})).status).toBe(400);
    expect((await mark(bob, { state: 'gelesen', reason: 42 })).status).toBe(400);
    expect((await mark(tokenFor('carol'), { state: 'abgelehnt' })).status).toBe(404);
  });
});

describe('who may see a task', () => {
  const task = (over: Partial<NewTask> = {}) =>
    createTask(storage.db, {
      kind: 'task',
      title: 'Entwurf',
      state: 'offen',
      createdBy: 'dora',
      ...over,
    });
  const traces = (taskId: ObjectId, token: string) =>
    request(server)
      .get('/events')
      .query({ anchorKind: 'task', anchorId: taskId.toHexString() })
      .set(as(token));

  it('follows its anchor, and a subtask follows its parent', async () => {
    const { workpieceId } = await setUp();
    const carol = tokenFor('carol');
    const top = await task({ anchor: { kind: 'workpiece', id: new ObjectId(workpieceId) } });
    const child = await task({ kind: 'review', parentId: top._id });

    expect((await traces(top._id, bob)).status).toBe(200);
    expect((await traces(child._id, bob)).status).toBe(200);
    expect((await traces(child._id, carol)).status).toBe(404);
  });

  it('shows a task without anchor to its creator and to whom it belongs', async () => {
    const reading = await task({ assignee: { kind: 'actor', id: 'carol' } });

    expect((await traces(reading._id, tokenFor('dora'))).status).toBe(200);
    expect((await traces(reading._id, tokenFor('carol'))).status).toBe(200);
    expect((await traces(reading._id, bob)).status).toBe(404);
  });

  it('shows a task given to a group to its members', async () => {
    const { groupId } = await setUp();
    const shared = await task({ assignee: { kind: 'group', id: new ObjectId(groupId) } });

    expect((await traces(shared._id, bob)).status).toBe(200);
    expect((await traces(shared._id, tokenFor('carol'))).status).toBe(404);
  });
});
