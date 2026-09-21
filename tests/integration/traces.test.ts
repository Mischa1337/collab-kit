import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import type { ActorRecord } from '../../src/db/collections/actors.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createDocument } from '../../src/db/collections/documents.ts';
import { latestEvent, readEvents } from '../../src/db/collections/events.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createDocumentHub, type DocumentHub } from '../../src/realtime/hub.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createServer } from '../../src/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_traces_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;
let hub: DocumentHub;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;

async function freshDocument(): Promise<ObjectId> {
  const document = await createDocument(storage.db, { name: 'Entwurf', createdBy: 'alice' });
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  const group = await createGroup(storage.db, {
    name: 'Teilnehmende',
    createdBy: 'alice',
    members: ['alice', 'bob', 'carol'],
  });
  await addToRoom(storage.db, room._id, {
    kind: 'document',
    id: document._id,
    addedBy: 'alice',
  });
  await addToRoom(storage.db, room._id, { kind: 'group', id: group._id, addedBy: 'alice' });
  return document._id;
}

const open = (documentId: ObjectId, actor: string) =>
  connectClient(`ws://127.0.0.1:${port}/ws/${documentId.toHexString()}`, [
    'bearer',
    jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' }),
  ]);

const on = (documentId: ObjectId) => ({ kind: 'document', id: documentId });

const traced = (documentId: ObjectId, kind: string, actorId: string) =>
  waitFor(
    async () => (await latestEvent(storage.db, { anchor: on(documentId), kind, actorId })) !== null,
  );

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  server = createServer({ logger: silent });
  hub = createDocumentHub({ db: storage.db, logger: silent });
  gateway = attachGateway({
    server,
    db: storage.db,
    hub,
    checkToken: createTokenCheck({ secret }),
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
    const documentId = await freshDocument();

    const alice = await open(documentId, 'alice');
    await alice.synced;
    expect(await traced(documentId, 'joined', 'alice')).toBe(true);

    await alice.close();
    expect(await traced(documentId, 'left', 'alice')).toBe(true);

    const all = await readEvents(storage.db, { anchor: on(documentId), actorId: 'alice' });
    expect(all.map((event) => event.kind)).toEqual(['left', 'joined']);
  });

  it('records the actor on the way in', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;

    const actors = storage.db.collection<ActorRecord>('actors');
    expect(await waitFor(async () => (await actors.findOne({ _id: 'alice' })) !== null)).toBe(true);

    const stored = await actors.findOne({ _id: 'alice' });
    expect(stored).toMatchObject({ _id: 'alice', label: 'alice' });
    expect(stored?.firstSeenAt).toBeInstanceOf(Date);
    expect(stored?.lastSeenAt).toBeInstanceOf(Date);

    await alice.close();
  });

  it('marks where in the stream somebody left', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'erst');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, documentId)).length === 1),
    ).toBe(true);

    await alice.close();
    expect(await traced(documentId, 'left', 'alice')).toBe(true);

    const left = await latestEvent(storage.db, {
      anchor: on(documentId),
      kind: 'left',
      actorId: 'alice',
    });
    const newest = (await readUpdatesSince(storage.db, documentId)).at(-1);
    expect(left?.at).toEqual(newest?._id);
  });

  it('answers what happened while somebody was away', async () => {
    const documentId = await freshDocument();

    const alice = await open(documentId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'erst');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, documentId)).length === 1),
    ).toBe(true);
    await alice.close();
    expect(await traced(documentId, 'left', 'alice')).toBe(true);

    const bob = await open(documentId, 'bob');
    await bob.synced;
    bob.doc.getText('t').insert(4, ' dann');
    bob.doc.getText('t').insert(9, ' und noch was');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, documentId)).length === 3),
    ).toBe(true);
    await bob.close();

    // D6.18: everything after the place alice left is what she missed.
    const mark = await latestEvent(storage.db, {
      anchor: on(documentId),
      kind: 'left',
      actorId: 'alice',
    });
    const missed = await readUpdatesSince(storage.db, documentId, mark?.at);

    expect(missed).toHaveLength(2);
    expect(missed.every((row) => row.actorId === 'bob')).toBe(true);
  });
});

describe('checkpoint', () => {
  it('holds the moment with a name and a why', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'stand');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, documentId)).length === 1),
    ).toBe(true);

    const marked = await hub.checkpoint(documentId, {
      actorId: 'alice',
      label: 'Abgabe 1',
      reason: 'vor dem Umbau des Kundenteils',
    });

    expect(marked).toMatchObject({
      kind: 'checkpoint',
      actorId: 'alice',
      label: 'Abgabe 1',
      reason: 'vor dem Umbau des Kundenteils',
    });

    const newest = (await readUpdatesSince(storage.db, documentId)).at(-1);
    expect(marked.at).toEqual(newest?._id);

    await alice.close();
  });

  it('carries neither name nor why when nobody gave one', async () => {
    const documentId = await freshDocument();
    const marked = await hub.checkpoint(documentId, { actorId: 'carol' });

    expect(marked.label).toBeUndefined();
    expect(marked.reason).toBeUndefined();
  });

  it('works on a document nobody has open and does not open it', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'geschlossen');
    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, documentId)).length === 1),
    ).toBe(true);
    await alice.close();
    expect(await waitFor(() => gateway.countFor(documentId.toHexString()) === 0)).toBe(true);

    const marked = await hub.checkpoint(documentId, { actorId: 'carol', label: 'nachtraeglich' });

    const newest = (await readUpdatesSince(storage.db, documentId)).at(-1);
    expect(marked.at).toEqual(newest?._id);
    expect(gateway.countFor(documentId.toHexString())).toBe(0);
  });

  it('points at nothing on a document that was never changed', async () => {
    const documentId = await freshDocument();
    const marked = await hub.checkpoint(documentId, { actorId: 'alice', label: 'leer' });

    expect(marked.at).toBeUndefined();
  });

  it('refuses a document nobody created', async () => {
    await expect(hub.checkpoint(new ObjectId(), { actorId: 'alice' })).rejects.toThrowError(
      /unknown document/,
    );
  });

  it('marks what has arrived, and loses nothing that is still on its way', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'vorher');
    const marking = hub.checkpoint(documentId, { actorId: 'alice', label: 'gleichzeitig' });
    alice.doc.getText('t').insert(6, ' nachher');
    const marked = await marking;

    expect(
      await waitFor(async () => (await readUpdatesSince(storage.db, documentId)).length === 2),
    ).toBe(true);
    const stored = await readUpdatesSince(storage.db, documentId);

    // The service can only mark what has reached it. A change still on the wire lands
    // behind the mark, never inside it, and the mark never names something that is
    // not in the stream.
    if (marked.at === undefined) {
      expect(stored.length).toBeGreaterThan(0);
    } else {
      expect(stored.some((row) => row._id.equals(marked.at!))).toBe(true);
    }

    await alice.close();
    expect(await waitFor(() => gateway.countFor(documentId.toHexString()) === 0)).toBe(true);

    const bob = await open(documentId, 'bob');
    await bob.synced;
    expect(await waitFor(() => bob.doc.getText('t').toString() === 'vorher nachher')).toBe(true);
    await bob.close();
  });
});
