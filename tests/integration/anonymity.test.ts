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
import { findComment } from '../../src/db/collections/comments.ts';
import { readEvents, type EventRecord } from '../../src/db/collections/events.ts';
import { setGrant } from '../../src/db/collections/grants.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { pseudonymOf, type Stamp } from '../../src/db/collections/pseudonyms.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { findTask } from '../../src/db/collections/tasks.ts';
import { readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createWorkpiece, findWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import type { Reference } from '../../src/model/anchor.ts';
import { RIGHTS, type Right } from '../../src/model/right.ts';
import { attachGateway, createWorkpieceHub, type Gateway } from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_anonymity_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });
/** How long removals here wait for more before they are written. */
const PAUSE = 200;
/** What every pseudonym looks like. */
const PSEUDONYM = /^anon-\d{4}$/;
/** What the members of the room may do there, openly or not. */
const WRITING: [Right, ...Right[]] = ['see', 'speak', 'edit', 'plan'];

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;

const tokenOf = (actor: string) =>
  jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' });
const as = (actor: string) => ({ Authorization: `Bearer ${tokenOf(actor)}` });

/** A room with a workpiece where bob writes openly and carol anonymously; alice manages all. */
interface Seminar {
  readonly roomId: ObjectId;
  readonly workpieceId: ObjectId;
  readonly bobs: ObjectId;
  readonly carols: ObjectId;
}

/** Sets a grant at the room as alice, with or without the flag. */
const grant = (groupId: ObjectId, roomId: ObjectId, anonymous: boolean) =>
  request(server)
    .put('/grants')
    .set(as('alice'))
    .send({
      groupId: groupId.toHexString(),
      scope: { kind: 'room', id: roomId.toHexString() },
      rights: WRITING,
      ...(anonymous ? { anonymous: true } : {}),
    });

/** A fresh seminar, so no test leans on what another wrote. */
async function seminar(): Promise<Seminar> {
  const { db } = storage;
  const room = await createRoom(db, { name: 'Seminar', createdBy: 'alice' });
  const workpiece = await createWorkpiece(db, { name: 'Entwurf', createdBy: 'alice' });
  await addToRoom(db, room._id, { workpieceId: workpiece._id, addedBy: 'alice' });
  const bobs = await createGroup(db, { name: 'Offen', createdBy: 'alice', members: ['bob'] });
  const carols = await createGroup(db, { name: 'Anonym', createdBy: 'alice', members: ['carol'] });
  const scope = { kind: 'room' as const, id: room._id };
  await setGrant(db, { groupId: bobs._id, scope, rights: WRITING, setBy: 'alice' });
  await setGrant(db, {
    groupId: carols._id,
    scope,
    rights: WRITING,
    anonymous: true,
    setBy: 'alice',
  });
  return { roomId: room._id, workpieceId: workpiece._id, bobs: bobs._id, carols: carols._id };
}

/** Says something about the workpiece as this person and gives the stored comment. */
async function say(actor: string, workpieceId: ObjectId) {
  const said = await request(server)
    .post('/comments')
    .set(as(actor))
    .send({
      kind: 'comment',
      anchor: { kind: 'workpiece', id: workpieceId.toHexString() },
      body: {},
    });
  expect(said.status).toBe(201);
  return (await findComment(storage.db, new ObjectId(said.body._id as string)))!;
}

/** The events of one kind at a place, oldest first. */
const eventsAt = async (anchor: Reference, kind: string): Promise<EventRecord[]> =>
  (await readEvents(storage.db, { anchor, kind })).toReversed();

/** The one stamp of this key, or undefined if it went openly. */
const stampOf = (stamps: readonly Stamp[] | undefined, key: string) =>
  stamps?.find((stamp) => stamp.key === key);

/** Opens the workpiece as this person. */
const open = async (workpieceId: ObjectId, actor: string, doc = new Y.Doc()) => {
  const client = await connectClient(
    `ws://127.0.0.1:${port}/ws/${workpieceId.toHexString()}`,
    ['bearer', tokenOf(actor)],
    doc,
  );
  await client.synced;
  return client;
};

/** Waits until this many changes of the workpiece are stored. */
const stored = async (workpieceId: ObjectId, count: number) =>
  expect(
    await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === count),
  ).toBe(true);

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  // Alice may do everything everywhere, openly.
  const staff = await createGroup(storage.db, {
    name: 'Lehrende',
    createdBy: 'alice',
    members: ['alice'],
  });
  await setGrant(storage.db, {
    groupId: staff._id,
    rights: [...RIGHTS] as [Right, ...Right[]],
    setBy: 'alice',
  });

  const hub = createWorkpieceHub({ db: storage.db, logger: silent, bundlePause: PAUSE });
  const checkToken = createTokenCheck({ key: secret, algorithm: 'HS256' });
  server = createServer({
    logger: silent,
    api: createApi({
      db: storage.db,
      hub,
      checkToken,
      logger: silent,
      // The gateway is attached below, as in main.ts.
      recheckAccess: () => gateway.recheck(),
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

describe('the flag on a grant', () => {
  it('is set and replaced with the rights, and its trace says so', async () => {
    const { roomId, bobs } = await seminar();

    const flagged = await grant(bobs, roomId, true);
    expect(flagged.status).toBe(200);
    expect(flagged.body.anonymous).toBe(true);
    const [set] = (await eventsAt({ kind: 'room', id: roomId }, 'grant-set')).toReversed();
    expect(set?.detail).toMatchObject({ rights: WRITING, anonymous: true });

    // Set again without it, the grant is open again.
    const opened = await grant(bobs, roomId, false);
    expect(opened.body.anonymous).toBeUndefined();
  });

  it('takes only true or false', async () => {
    const { roomId, bobs } = await seminar();

    const refused = await request(server)
      .put('/grants')
      .set(as('alice'))
      .send({
        groupId: bobs.toHexString(),
        scope: { kind: 'room', id: roomId.toHexString() },
        rights: WRITING,
        anonymous: 'ja',
      });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('anonymous is unusable');
  });
});

describe('stamps when written', () => {
  it('stamps what an anonymous member writes, and nothing anybody else writes', async () => {
    const { workpieceId } = await seminar();

    const hidden = await say('carol', workpieceId);
    const stamp = stampOf(hidden.anonymous, 'carol');
    expect(stamp?.as).toMatch(PSEUDONYM);
    const [created] = await eventsAt({ kind: 'comment', id: hidden._id }, 'comment-created');
    expect(created?.anonymous).toEqual([stamp]);

    const shown = await say('bob', workpieceId);
    expect(shown.anonymous).toBeUndefined();
    const [plain] = await eventsAt({ kind: 'comment', id: shown._id }, 'comment-created');
    expect(plain?.anonymous).toBeUndefined();
  });

  it('keeps one pseudonym per workpiece for comments and tasks alike, another one elsewhere', async () => {
    const { roomId, workpieceId } = await seminar();
    const other = await createWorkpiece(storage.db, { name: 'Zweites', createdBy: 'alice' });
    await addToRoom(storage.db, roomId, { workpieceId: other._id, addedBy: 'alice' });

    const comment = await say('carol', workpieceId);
    const task = await request(server)
      .post('/tasks')
      .set(as('carol'))
      .send({
        kind: 'task',
        title: 'Entitäten',
        state: 'open',
        anchor: { kind: 'workpiece', id: workpieceId.toHexString() },
      });
    const elsewhere = await say('carol', other._id);

    const here = stampOf(comment.anonymous, 'carol')?.as;
    const planned = await findTask(storage.db, new ObjectId(task.body._id as string));
    expect(stampOf(planned?.anonymous, 'carol')?.as).toBe(here);
    // Elsewhere it is drawn about the other workpiece.
    expect(stampOf(elsewhere.anonymous, 'carol')?.as).toBe(
      await pseudonymOf(storage.db, { kind: 'workpiece', id: other._id }, 'carol'),
    );
    expect(
      await storage.db
        .collection('pseudonyms')
        .countDocuments({ key: 'carol', 'about.id': { $in: [workpieceId, other._id] } }),
    ).toBe(2);
  });

  it('leaves open what was written before the flag, and stamped what was written under it', async () => {
    const { roomId, workpieceId, bobs } = await seminar();

    const before = await say('bob', workpieceId);
    await grant(bobs, roomId, true);
    const under = await say('bob', workpieceId);
    await grant(bobs, roomId, false);

    expect((await findComment(storage.db, before._id))?.anonymous).toBeUndefined();
    expect(stampOf((await findComment(storage.db, under._id))?.anonymous, 'bob')?.as).toMatch(
      PSEUDONYM,
    );
  });

  it('keeps a person in a comment as they stood there, whatever the flag says by now', async () => {
    const { roomId, workpieceId, bobs, carols } = await seminar();

    // Said openly, deleted under the flag: the deletion stays open too.
    const shown = await say('bob', workpieceId);
    await grant(bobs, roomId, true);
    await request(server).delete(`/comments/${shown._id.toHexString()}`).set(as('bob'));
    expect((await findComment(storage.db, shown._id))?.anonymous).toBeUndefined();
    const [deleted] = await eventsAt({ kind: 'comment', id: shown._id }, 'comment-deleted');
    expect(deleted?.anonymous).toBeUndefined();

    // Said anonymously, then the flag falls: what carol does to it stays anonymous.
    const hidden = await say('carol', workpieceId);
    const stamp = stampOf(hidden.anonymous, 'carol');
    await grant(carols, roomId, false);
    await request(server)
      .post('/events')
      .set(as('carol'))
      .send({ kind: 'read', anchor: { kind: 'comment', id: hidden._id.toHexString() } });
    await request(server).delete(`/comments/${hidden._id.toHexString()}`).set(as('carol'));

    const [read] = await eventsAt({ kind: 'comment', id: hidden._id }, 'read');
    expect(read?.anonymous).toEqual([stamp]);
    const [gone] = await eventsAt({ kind: 'comment', id: hidden._id }, 'comment-deleted');
    expect(gone?.anonymous).toEqual([stamp]);
    expect((await findComment(storage.db, hidden._id))?.anonymous).toEqual([stamp]);
  });

  it('gives a task on nothing one pseudonym for its whole tree', async () => {
    const planners = await createGroup(storage.db, {
      name: 'Planende',
      createdBy: 'alice',
      members: ['dave'],
    });
    await setGrant(storage.db, {
      groupId: planners._id,
      rights: ['see', 'plan'],
      anonymous: true,
      setBy: 'alice',
    });

    const top = await request(server)
      .post('/tasks')
      .set(as('dave'))
      .send({ kind: 'task', title: 'Projekt', state: 'open' });
    const sub = await request(server)
      .post('/tasks')
      .set(as('dave'))
      .send({ kind: 'task', title: 'Teil', state: 'open', parentId: top.body._id });

    const topId = new ObjectId(top.body._id as string);
    const topStamp = stampOf((await findTask(storage.db, topId))?.anonymous, 'dave');
    const subTask = await findTask(storage.db, new ObjectId(sub.body._id as string));
    expect(topStamp?.as).toMatch(PSEUDONYM);
    expect(stampOf(subTask?.anonymous, 'dave')).toEqual(topStamp);
    expect(await pseudonymOf(storage.db, { kind: 'task', id: topId }, 'dave')).toBe(topStamp?.as);
  });

  it('stamps whom a task is given to, but not who gave it openly', async () => {
    const { workpieceId } = await seminar();

    const created = await request(server)
      .post('/tasks')
      .set(as('bob'))
      .send({
        kind: 'task',
        title: 'Beziehungen',
        state: 'open',
        anchor: { kind: 'workpiece', id: workpieceId.toHexString() },
      });
    const taskId = new ObjectId(created.body._id as string);
    await request(server)
      .post(`/tasks/${taskId.toHexString()}/assignees`)
      .set(as('bob'))
      .send({ kind: 'actor', id: 'carol' });

    const task = await findTask(storage.db, taskId);
    const stamp = stampOf(task?.anonymous, 'carol');
    expect(stamp?.as).toMatch(PSEUDONYM);
    expect(stampOf(task?.anonymous, 'bob')).toBeUndefined();
    const [added] = await eventsAt({ kind: 'task', id: taskId }, 'assignee-added');
    expect(added?.anonymous).toEqual([stamp]);
  });

  it('stamps a workpiece created in a room with the flag, under its own pseudonym', async () => {
    const { roomId } = await seminar();

    const created = await request(server)
      .post('/workpieces')
      .set(as('carol'))
      .send({ name: 'Eigenes', roomId: roomId.toHexString() });
    expect(created.status).toBe(201);

    const id = new ObjectId(created.body._id as string);
    const workpiece = await findWorkpiece(storage.db, id);
    expect(stampOf(workpiece?.anonymous, 'carol')?.as).toBe(
      await pseudonymOf(storage.db, { kind: 'workpiece', id }, 'carol'),
    );
  });

  it('draws one pseudonym per key and thing, and never the same one twice there', async () => {
    const about: Reference = { kind: 'workpiece', id: new ObjectId() };
    const keys = Array.from({ length: 40 }, (_, index) => `person-${index}`);

    const drawn = await Promise.all(keys.map((key) => pseudonymOf(storage.db, about, key)));
    const again = await Promise.all(keys.map((key) => pseudonymOf(storage.db, about, key)));

    expect(new Set(drawn).size).toBe(keys.length);
    expect(again).toEqual(drawn);
    expect(drawn.every((pseudonym) => PSEUDONYM.test(pseudonym))).toBe(true);
  });
});

describe('keys like a pseudonym', () => {
  it('are taken from no token, no member and no assignee', async () => {
    const { workpieceId, bobs } = await seminar();

    expect((await request(server).get('/me').set(as('anon-1234'))).status).toBe(401);
    const member = await request(server)
      .post(`/groups/${bobs.toHexString()}/members`)
      .set(as('alice'))
      .send({ actorId: 'anon-1234' });
    expect(member.status).toBe(400);
    const task = await request(server)
      .post('/tasks')
      .set(as('bob'))
      .send({
        kind: 'task',
        title: 'Falsch',
        state: 'open',
        anchor: { kind: 'workpiece', id: workpieceId.toHexString() },
        assignees: [{ kind: 'actor', id: 'anon-1234' }],
      });
    expect(task.status).toBe(400);
  });
});

describe('stamps over the socket', () => {
  it('stamps the changes and the presence of an anonymous connection, not of an open one', async () => {
    const { workpieceId } = await seminar();
    const anchor: Reference = { kind: 'workpiece', id: workpieceId };

    const carol = await open(workpieceId, 'carol');
    carol.doc.getText('t').insert(0, 'a');
    await stored(workpieceId, 1);
    const bob = await open(workpieceId, 'bob');
    bob.doc.getText('t').insert(1, 'b');
    await stored(workpieceId, 2);
    await carol.close();
    await bob.close();
    await waitFor(() => gateway.countFor(workpieceId) === 0);

    const [hers, his] = await readUpdatesSince(storage.db, workpieceId);
    const stamp = stampOf(hers?.anonymous, 'carol');
    expect(stamp?.as).toBe(await pseudonymOf(storage.db, anchor, 'carol'));
    expect(his?.anonymous).toBeUndefined();

    const presence = [...(await eventsAt(anchor, 'joined')), ...(await eventsAt(anchor, 'left'))];
    for (const event of presence) {
      expect(event.anonymous).toEqual(event.createdBy === 'carol' ? [stamp] : undefined);
    }
  });

  it('closes a connection with 4409 once the flag changes for it', async () => {
    const { roomId, workpieceId, bobs } = await seminar();

    const bob = await open(workpieceId, 'bob');
    await grant(bobs, roomId, true);

    expect(await bob.closed).toBe(4409);
  });

  it('closes it too when its workpiece comes into a room with the flag', async () => {
    const { roomId, carols } = await seminar();
    const apart = await createWorkpiece(storage.db, { name: 'Draußen', createdBy: 'alice' });
    await setGrant(storage.db, {
      groupId: carols,
      scope: { kind: 'workpiece', id: apart._id },
      rights: ['see', 'edit'],
      setBy: 'alice',
    });

    const carol = await open(apart._id, 'carol');
    const added = await request(server)
      .post(`/rooms/${roomId.toHexString()}/workpieces`)
      .set(as('alice'))
      .send({ workpieceId: apart._id.toHexString() });
    expect(added.status).toBe(201);

    expect(await carol.closed).toBe(4409);
  });

  it('stamps whose work was removed as it was written, not as the flag says by now', async () => {
    const { roomId, workpieceId, carols } = await seminar();
    const anchor: Reference = { kind: 'workpiece', id: workpieceId };

    const carol = await open(workpieceId, 'carol');
    carol.doc.getText('t').insert(0, 'abc');
    await stored(workpieceId, 1);
    const [written] = await readUpdatesSince(storage.db, workpieceId);
    // The flag falls, so carol would now write openly.
    await grant(carols, roomId, false);
    await carol.closed;

    const bob = await open(workpieceId, 'bob');
    bob.doc.getText('t').delete(0, 3);
    expect(await waitFor(async () => (await eventsAt(anchor, 'work-removed')).length === 1)).toBe(
      true,
    );
    await bob.close();

    const [removed] = await eventsAt(anchor, 'work-removed');
    expect(removed?.affects).toEqual(['carol']);
    expect(removed?.anonymous).toEqual(written?.anonymous);
  });
});

describe('forks and merges', () => {
  it('keeps the stamps of the source in a fork, and the pseudonyms with them', async () => {
    const { workpieceId } = await seminar();
    const carol = await open(workpieceId, 'carol');
    carol.doc.getText('t').insert(0, 'a');
    await stored(workpieceId, 1);
    await carol.close();
    const source = await pseudonymOf(storage.db, { kind: 'workpiece', id: workpieceId }, 'carol');

    // Bob forks it openly, carol under the pseudonym she already has there.
    const byBob = await request(server)
      .post(`/workpieces/${workpieceId.toHexString()}/forks`)
      .set(as('bob'))
      .send({ name: 'Kopie' });
    const byCarol = await request(server)
      .post(`/workpieces/${workpieceId.toHexString()}/forks`)
      .set(as('carol'))
      .send({ name: 'Eigene Kopie' });
    const bobsFork = new ObjectId(byBob.body._id as string);
    const carolsFork = new ObjectId(byCarol.body._id as string);

    const [copied] = await readUpdatesSince(storage.db, bobsFork);
    expect(stampOf(copied?.anonymous, 'carol')?.as).toBe(source);
    expect(await pseudonymOf(storage.db, { kind: 'workpiece', id: bobsFork }, 'carol')).toBe(
      source,
    );
    expect((await findWorkpiece(storage.db, bobsFork))?.anonymous).toBeUndefined();
    expect(stampOf((await findWorkpiece(storage.db, carolsFork))?.anonymous, 'carol')?.as).toBe(
      source,
    );
  });

  it('brings anonymous work back anonymous, under the pseudonym of the target', async () => {
    const { workpieceId } = await seminar();
    const carol = await open(workpieceId, 'carol');
    carol.doc.getText('t').insert(0, 'a');
    await stored(workpieceId, 1);
    await carol.close();

    // A target where carol writes openly.
    const elsewhere = await createRoom(storage.db, { name: 'Offen', createdBy: 'alice' });
    const target = await createWorkpiece(storage.db, { name: 'Ziel', createdBy: 'alice' });
    await addToRoom(storage.db, elsewhere._id, { workpieceId: target._id, addedBy: 'alice' });
    const openly = await createGroup(storage.db, {
      name: 'Offen',
      createdBy: 'alice',
      members: ['carol'],
    });
    await setGrant(storage.db, {
      groupId: openly._id,
      scope: { kind: 'room', id: elsewhere._id },
      rights: WRITING,
      setBy: 'alice',
    });

    const merged = await request(server)
      .post(`/workpieces/${target._id.toHexString()}/merges`)
      .set(as('alice'))
      .send({ from: workpieceId.toHexString() });
    expect(merged.status).toBe(201);

    const there = await pseudonymOf(storage.db, { kind: 'workpiece', id: target._id }, 'carol');
    const [brought] = await readUpdatesSince(storage.db, target._id);
    expect(brought?.anonymous).toEqual([{ key: 'carol', as: there }]);
    const [event] = await eventsAt({ kind: 'workpiece', id: target._id }, 'workpiece-merged');
    expect(event?.anonymous).toEqual([{ key: 'carol', as: there }]);
  });
});
