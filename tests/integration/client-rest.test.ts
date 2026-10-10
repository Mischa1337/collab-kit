import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import pino from 'pino';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CollabKitError, type CollabKitApi, type Session } from '../../client/src/api.ts';
import { createCollabKitApi } from '../../client/src/index.ts';
import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { attachGateway, createWorkpieceHub, type Gateway } from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';
import { waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_client_rest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

/** Every route of CK, as the wrapper has to reach them. */
const ROUTES = [
  'GET /me',
  'GET /me/rights',
  'GET /me/rooms',
  'GET /me/groups',
  'GET /me/tasks',
  'GET /me/events',
  'POST /rooms',
  'GET /rooms/:id',
  'PATCH /rooms/:id',
  'DELETE /rooms/:id',
  'POST /rooms/:id/references',
  'DELETE /rooms/:id/references',
  'GET /rooms/:id/events',
  'GET /rooms/:id/activity',
  'POST /groups',
  'GET /groups',
  'GET /groups/:id',
  'PATCH /groups/:id',
  'DELETE /groups/:id',
  'POST /groups/:id/members',
  'DELETE /groups/:id/members/:actorId',
  'PUT /grants',
  'DELETE /grants',
  'GET /grants',
  'POST /workpieces',
  'GET /workpieces',
  'GET /workpieces/:id',
  'GET /workpieces/:id/updates',
  'GET /workpieces/:id/activity',
  'GET /workpieces/:id/state',
  'POST /workpieces/:id/checkpoints',
  'POST /workpieces/:id/forks',
  'POST /workpieces/:id/merges',
  'POST /comments',
  'GET /comments/:id',
  'GET /comments',
  'PATCH /comments/:id',
  'DELETE /comments/:id',
  'POST /tasks',
  'GET /tasks/:id',
  'GET /tasks',
  'PATCH /tasks/:id',
  'POST /tasks/:id/assignees',
  'DELETE /tasks/:id/assignees',
  'POST /events',
  'GET /events',
  'GET /actors',
];

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let url: string;

// Alice is at the top and may everything, bob and carol only what a grant gives them.
let alice: CollabKitApi;
let bob: CollabKitApi;
let carol: CollabKitApi;

// Every route the wrapper called, with keys in place of the ids.
const called = new Set<string>();
const realFetch = globalThis.fetch;

/** The wrapper as this person, the name in the token with a capital. */
function as(actor: string, top = false): CollabKitApi {
  const name = `${actor[0]?.toUpperCase()}${actor.slice(1)}`;
  const token = jwt.sign({ sub: actor, name, ...(top ? { globalRole: 'ADMIN' } : {}) }, secret, {
    expiresIn: '15m',
  });
  return createCollabKitApi({ url, getToken: () => token });
}

// Every session a test opens, closed after it.
const opened: Session[] = [];

/** Opens a session and remembers it for closing. */
function open(ck: CollabKitApi, workpieceId: string): Session {
  const session = ck.open(workpieceId);
  opened.push(session);
  return session;
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const hub = createWorkpieceHub({ db: storage.db, logger: silent });
  const checkToken = createTokenCheck({
    key: secret,
    algorithm: 'HS256',
    top: { claim: 'globalRole', values: ['ADMIN'] },
  });
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
  alice = as('alice', true);
  bob = as('bob');
  carol = as('carol');

  // Notes every call on its way out, so the last test can tell which routes were reached.
  globalThis.fetch = (input, init) => {
    const { pathname } = new URL(String(input));
    const route = pathname
      .replaceAll(/\/[0-9a-f]{24}(?=\/|$)/g, '/:id')
      .replace(/\/members\/[^/]+$/, '/members/:actorId');
    called.add(`${init?.method ?? 'GET'} ${route}`);
    return realFetch(input, init);
  };
});

afterEach(() => {
  for (const session of opened.splice(0)) {
    session.close();
  }
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await storage.db.dropDatabase();
  await storage.close();
});

describe('the REST wrapper', () => {
  it('names the token: who, and the rights everywhere', async () => {
    expect(await alice.me.who()).toEqual({ actorId: 'alice', label: 'Alice' });
    expect(await alice.me.rights()).toEqual(['see', 'speak', 'edit', 'plan', 'decide', 'manage']);
    expect(await bob.me.rights()).toEqual([]);
  });

  it('builds a room with a group in it, and takes both down again', async () => {
    const room = await alice.rooms.create({ name: 'Seminar', settings: { color: 'blue' } });
    expect(room).toMatchObject({
      name: 'Seminar',
      settings: { color: 'blue' },
      references: [],
      createdBy: 'alice',
      names: { alice: 'Alice' },
    });
    expect(await alice.rooms.update(room._id, { name: 'Seminar 2', reason: 'umbenannt' })).toEqual(
      expect.objectContaining({ name: 'Seminar 2' }),
    );
    expect((await alice.rooms.get(room._id)).name).toBe('Seminar 2');

    const group = await alice.groups.create({ name: 'Team', members: ['bob'] });
    expect((await alice.groups.list()).map((each) => each._id)).toContain(group._id);
    expect((await alice.groups.update(group._id, { settings: { role: 'team' } })).settings).toEqual(
      { role: 'team' },
    );
    expect((await alice.groups.addMember(group._id, 'carol')).members).toEqual(['bob', 'carol']);
    expect((await alice.groups.removeMember(group._id, 'carol')).members).toEqual(['bob']);
    expect((await alice.groups.get(group._id)).name).toBe('Team');
    expect((await bob.me.groups()).map((each) => each._id)).toContain(group._id);

    const scope = { kind: 'room', id: room._id };
    expect(await alice.grants.set({ groupId: group._id, scope, rights: ['see', 'speak'] })).toEqual(
      expect.objectContaining({ groupId: group._id, scope, rights: ['see', 'speak'] }),
    );
    expect(await alice.grants.list({ scope })).toHaveLength(1);
    expect(await alice.grants.list({ groupId: group._id })).toHaveLength(1);
    expect(await bob.me.rights(scope)).toEqual(['see', 'speak']);
    expect((await bob.me.rooms()).map((each) => each._id)).toEqual([room._id]);

    const workpiece = await alice.workpieces.create({ name: 'Entwurf' });
    const reference = { kind: 'workpiece', id: workpiece._id };
    expect((await alice.rooms.addReference(room._id, reference)).references).toEqual([reference]);
    expect((await alice.rooms.events(room._id, { kind: 'reference-added' })).length).toBe(1);
    expect((await alice.rooms.activity(room._id)).map((each) => each.actorId)).toEqual(['alice']);
    expect((await alice.rooms.removeReference(room._id, reference)).references).toEqual([]);

    expect(await alice.grants.remove({ groupId: group._id, scope, reason: 'vorbei' })).toEqual({
      removed: true,
    });
    expect(await bob.me.rights(scope)).toEqual([]);
    expect(await alice.groups.remove(group._id)).toEqual({ deleted: true });
    expect(await alice.rooms.remove(room._id, { reason: 'vorbei' })).toEqual({ deleted: true });
  });

  it('reads what sessions wrote, forks, merges, and tells whose work came in', async () => {
    const room = await alice.rooms.create({ name: 'Labor' });
    const group = await alice.groups.create({ name: 'Werkstatt', members: ['carol'] });
    await alice.grants.set({
      groupId: group._id,
      scope: { kind: 'room', id: room._id },
      rights: ['see', 'edit'],
    });
    const workpiece = await alice.workpieces.create({
      name: 'Modell',
      roomId: room._id,
      contract: { format: 'test' },
      units: [{ path: ['units'] }],
    });
    expect(workpiece).toMatchObject({ contract: { format: 'test' }, units: [{ path: ['units'] }] });
    expect((await alice.workpieces.get(workpiece._id)).name).toBe('Modell');
    expect((await alice.workpieces.list()).map((each) => each._id)).toContain(workpiece._id);

    // The content goes through a session, the routes read what it left.
    const original = open(alice, workpiece._id);
    await original.synced;
    original.units.update({ set: { a: 1 } });
    expect(
      await waitFor(async () => (await alice.workpieces.updates(workpiece._id)).length === 1),
    ).toBe(true);
    const [update] = await alice.workpieces.updates(workpiece._id, { limit: 1 });
    expect(update).toMatchObject({ createdBy: 'alice' });
    expect(update?.bytes).toBeGreaterThan(0);

    const { state, upToUpdateId } = await alice.workpieces.state(workpiece._id);
    expect(upToUpdateId).toBe(update?._id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    expect(doc.getMap('units').get('a')).toBe(1);

    expect(await alice.workpieces.checkpoint(workpiece._id, { label: 'Stand 1' })).toMatchObject({
      kind: 'checkpoint',
      label: 'Stand 1',
      at: update?._id,
    });
    expect((await alice.workpieces.activity(workpiece._id)).map((each) => each.actorId)).toEqual([
      'alice',
    ]);

    const fork = await alice.workpieces.fork(workpiece._id, { name: 'Abzweig', roomId: room._id });
    expect(fork.forkOf).toEqual({ id: workpiece._id, at: update?._id });
    const copy = open(carol, fork._id);
    await copy.synced;
    copy.units.update({ set: { b: 2 } });
    expect(await waitFor(async () => (await alice.workpieces.updates(fork._id)).length === 2)).toBe(
      true,
    );

    const merged = await alice.workpieces.merge(workpiece._id, { from: fork._id });
    expect(merged).toMatchObject({ kind: 'workpiece-merged', affects: ['carol'] });
    expect(await waitFor(() => original.units.get('b') === 2)).toBe(true);
    expect((await carol.me.events({ kind: 'workpiece-merged' })).map((event) => event._id)).toEqual(
      [merged._id],
    );
  });

  it('keeps comments and their answers, and takes the words of one away', async () => {
    const workpiece = await alice.workpieces.create({ name: 'Text' });
    const anchor = { kind: 'workpiece', id: workpiece._id, unit: 'k' };

    const comment = await alice.comments.create({ kind: 'note', anchor, body: { text: 'Hallo' } });
    const answer = await alice.comments.create({
      kind: 'note',
      anchor,
      body: { text: 'Ja' },
      parentId: comment._id,
    });
    expect((await alice.comments.get(answer._id)).parentId).toBe(comment._id);
    expect(
      (
        await alice.comments.list({
          anchorKind: 'workpiece',
          anchorId: workpiece._id,
          parentId: 'none',
        })
      ).map((each) => each._id),
    ).toEqual([comment._id]);
    expect(
      await alice.comments.update(comment._id, { body: { text: 'Hallo!' }, state: 'open' }),
    ).toMatchObject({ body: { text: 'Hallo!' }, state: 'open' });
    expect(await alice.comments.remove(comment._id, { reason: 'erledigt' })).toMatchObject({
      body: {},
      deletedBy: 'alice',
    });
  });

  it('plans tasks, gives them to people, and finds them as theirs', async () => {
    const workpiece = await alice.workpieces.create({ name: 'Plan' });
    const anchor = { kind: 'workpiece', id: workpiece._id };

    const task = await alice.tasks.create({
      kind: 'todo',
      title: 'Gliederung',
      state: 'open',
      anchor,
      assignees: [{ kind: 'actor', id: 'bob' }],
      order: 1,
    });
    const part = await alice.tasks.create({
      kind: 'todo',
      title: 'Einleitung',
      state: 'open',
      parentId: task._id,
    });
    expect((await alice.tasks.get(part._id)).parentId).toBe(task._id);
    expect((await alice.tasks.list({ parentId: task._id })).map((each) => each._id)).toEqual([
      part._id,
    ]);
    expect(
      (
        await alice.tasks.list({
          anchorKind: 'workpiece',
          anchorId: workpiece._id,
          assigneeKind: 'actor',
          assigneeId: 'bob',
        })
      ).map((each) => each._id),
    ).toEqual([task._id]);
    expect((await alice.tasks.update(task._id, { state: 'done', reason: 'fertig' })).state).toBe(
      'done',
    );

    const bobs = { kind: 'actor', id: 'bob' } as const;
    expect((await alice.tasks.addAssignee(part._id, bobs, { reason: 'hilft' })).assignees).toEqual([
      bobs,
    ]);
    expect((await bob.me.tasks({ state: 'open' })).map((each) => each._id)).toEqual([part._id]);
    expect((await alice.tasks.removeAssignee(part._id, bobs)).assignees).toEqual([]);
  });

  it('reports events of the tool and names the people', async () => {
    const workpiece = await alice.workpieces.create({ name: 'Notiz' });

    const visit = await alice.events.create({
      kind: 'visited',
      anchor: { kind: 'workpiece', id: workpiece._id },
      detail: { from: 'test' },
    });
    expect(visit).toMatchObject({ kind: 'visited', createdBy: 'alice', detail: { from: 'test' } });
    expect(
      (
        await alice.events.list({
          anchorKind: 'workpiece',
          anchorId: workpiece._id,
          kind: 'visited',
        })
      ).map((event) => event._id),
    ).toEqual([visit._id]);

    // Bob has called CK before, so his name is known.
    await bob.me.who();
    expect(
      (await alice.actors.names(['alice', 'bob'])).toSorted((one, other) =>
        one.actorId.localeCompare(other.actorId),
      ),
    ).toEqual([
      { actorId: 'alice', label: 'Alice' },
      { actorId: 'bob', label: 'Bob' },
    ]);
  });

  it('throws a CollabKitError with the status and the words of CK', async () => {
    const unknown = alice.rooms.get('0123456789abcdef01234567');
    await expect(unknown).rejects.toBeInstanceOf(CollabKitError);
    await expect(unknown).rejects.toMatchObject({ status: 404, message: 'unknown room' });

    await expect(bob.rooms.create({ name: 'Eigener Raum' })).rejects.toMatchObject({
      name: 'CollabKitError',
      status: 403,
      message: 'not allowed to create a room',
    });
  });

  it('reached every route of CK', () => {
    expect([...called].toSorted()).toEqual(ROUTES.toSorted());
  });
});
