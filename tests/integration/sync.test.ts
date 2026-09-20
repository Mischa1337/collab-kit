import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import pino from 'pino';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createDocument } from '../../src/db/documents.ts';
import { createRoom } from '../../src/db/rooms.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createDocumentHub } from '../../src/realtime/documents.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createServer } from '../../src/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

const tokenOf = (sub: string): string => jwt.sign({ sub, name: sub }, secret, { expiresIn: '15m' });

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;
let roomId: import('mongodb').ObjectId;

async function freshDocument(): Promise<string> {
  const document = await createDocument(storage.db, {
    roomId,
    name: 'Entwurf',
    actorId: 'alice',
    state: Y.encodeStateAsUpdate(new Y.Doc()),
  });
  return document.documentId.toHexString();
}

const open = (documentId: string, actor: string) =>
  connectClient(`ws://127.0.0.1:${port}/ws/${documentId}`, ['bearer', tokenOf(actor)]);

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  roomId = room._id;

  server = createServer({ logger: silent });
  gateway = attachGateway({
    server,
    db: storage.db,
    hub: createDocumentHub({ db: storage.db, logger: silent }),
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

describe('working on one document together', () => {
  it('carries a change from one client to the other and keeps it', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    const bob = await open(documentId, 'bob');
    await Promise.all([alice.synced, bob.synced]);

    alice.doc.getText('irgendwas').insert(0, 'hallo welt');

    expect(await waitFor(() => bob.doc.getText('irgendwas').toString() === 'hallo welt')).toBe(
      true,
    );

    const stored = await storage.db
      .collection('versions')
      .find({ documentId: new (await import('mongodb')).ObjectId(documentId) })
      .toArray();

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ actorId: 'alice', baseVersion: 1 });

    await alice.close();
    await bob.close();
  });

  it('hands a returning client everything it missed', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'erst');

    const bob = await open(documentId, 'bob');
    await bob.synced;

    expect(await waitFor(() => bob.doc.getText('t').toString() === 'erst')).toBe(true);
    await bob.close();

    alice.doc.getText('t').insert(4, ' dann');

    const bobAgain = await open(documentId, 'bob');
    await bobAgain.synced;

    expect(await waitFor(() => bobAgain.doc.getText('t').toString() === 'erst dann')).toBe(true);

    await alice.close();
    await bobAgain.close();
  });

  it('carries whatever shape the tool chose, the service never looks inside', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    const bob = await open(documentId, 'bob');
    await Promise.all([alice.synced, bob.synced]);

    const nodes = alice.doc.getMap('nodes');
    const entity = new Y.Map<unknown>();
    entity.set('label', 'Kunde');
    entity.set('attributes', Y.Array.from(['id', 'name']));
    nodes.set('n1', entity);

    const arrived = await waitFor(() => {
      const node = bob.doc.getMap('nodes').get('n1');
      return node instanceof Y.Map && node.get('label') === 'Kunde';
    });

    expect(arrived).toBe(true);
    const copy = bob.doc.getMap('nodes').get('n1') as Y.Map<unknown>;
    expect((copy.get('attributes') as Y.Array<string>).toArray()).toEqual(['id', 'name']);

    await alice.close();
    await bob.close();
  });

  it('rebuilds the document from the database once everyone has left', async () => {
    const documentId = await freshDocument();
    const first = await open(documentId, 'alice');
    await first.synced;
    first.doc.getText('t').insert(0, 'bleibt');

    expect(
      await waitFor(async () => (await storage.db.collection('versions').countDocuments({})) > 0),
    ).toBe(true);

    await first.close();
    expect(await waitFor(() => gateway.countFor(documentId) === 0)).toBe(true);

    const later = await open(documentId, 'carol');
    await later.synced;

    expect(await waitFor(() => later.doc.getText('t').toString() === 'bleibt')).toBe(true);
    await later.close();
  });

  it('brings two people writing at the same moment to the same result', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    const bob = await open(documentId, 'bob');
    await Promise.all([alice.synced, bob.synced]);

    alice.doc.getText('t').insert(0, 'AAA');
    bob.doc.getText('t').insert(0, 'BBB');

    const same = await waitFor(
      () =>
        alice.doc.getText('t').toString() === bob.doc.getText('t').toString() &&
        alice.doc.getText('t').toString().length === 6,
    );

    expect(same).toBe(true);
    expect(alice.doc.getText('t').toString()).toContain('AAA');
    expect(alice.doc.getText('t').toString()).toContain('BBB');

    await alice.close();
    await bob.close();
  });
});
