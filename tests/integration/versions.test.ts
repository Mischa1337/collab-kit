import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createDocument, createVersion, type DocumentVersion } from '../../src/db/documents.ts';
import { createRoom } from '../../src/db/rooms.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { readVersions } from '../../src/db/versions.ts';
import { createDocumentHub, type DocumentHub } from '../../src/realtime/documents.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createServer } from '../../src/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_versions_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;
let hub: DocumentHub;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;
let roomId: ObjectId;

async function freshDocument(): Promise<ObjectId> {
  const document = await createDocument(storage.db, {
    roomId,
    name: 'Entwurf',
    actorId: 'alice',
    state: Y.encodeStateAsUpdate(new Y.Doc()),
  });
  return document.documentId;
}

const open = (documentId: ObjectId, actor: string) =>
  connectClient(`ws://127.0.0.1:${port}/ws/${documentId.toHexString()}`, [
    'bearer',
    jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' }),
  ]);

const rowsOf = (documentId: ObjectId) =>
  storage.db
    .collection<DocumentVersion>('documents')
    .find({ documentId })
    .sort({ version: 1 })
    .toArray();

/** Rebuilds what a given version plus the changes on it amount to. */
async function contentOf(row: DocumentVersion, key = 't'): Promise<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.state.buffer));
  for (const change of await readVersions(storage.db, row.documentId, row.version)) {
    Y.applyUpdate(doc, new Uint8Array(change.update.buffer));
  }
  return doc.getText(key).toString();
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  roomId = room._id;

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

describe('createVersion', () => {
  it('adds the next version and moves isCurrent to it', async () => {
    const documentId = await freshDocument();
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'stand');

    const created = await createVersion(storage.db, {
      documentId,
      state: Y.encodeStateAsUpdate(doc),
      actorId: 'alice',
      label: 'Abgabe 1',
      reason: 'vor der Überarbeitung des Kundenteils',
    });

    expect(created).toMatchObject({
      version: 2,
      isCurrent: true,
      label: 'Abgabe 1',
      reason: 'vor der Überarbeitung des Kundenteils',
      actorId: 'alice',
    });

    const rows = await rowsOf(documentId);
    expect(rows.map((row) => [row.version, row.isCurrent])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(rows[1]).toMatchObject({ name: 'Entwurf', roomId });
  });

  it('carries neither label nor reason when nobody named it', async () => {
    const documentId = await freshDocument();

    const created = await createVersion(storage.db, {
      documentId,
      state: Y.encodeStateAsUpdate(new Y.Doc()),
      actorId: 'alice',
    });

    expect(created.label).toBeUndefined();
    expect(created.reason).toBeUndefined();
  });

  it('refuses a document that has no current version', async () => {
    await expect(
      createVersion(storage.db, {
        documentId: new ObjectId(),
        state: Y.encodeStateAsUpdate(new Y.Doc()),
        actorId: 'alice',
      }),
    ).rejects.toThrowError(/no current version/);
  });
});

describe('marking a version while people are working', () => {
  it('takes the state from memory and lets later changes hang on the new base', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'erst');
    expect(
      await waitFor(async () => (await readVersions(storage.db, documentId, 1)).length > 0),
    ).toBe(true);

    const marked = await hub.markVersion(documentId, {
      actorId: 'alice',
      label: 'Abgabe 1',
      reason: 'Stand der Besprechung',
    });
    expect(marked.version).toBe(2);

    alice.doc.getText('t').insert(4, ' dann');
    expect(
      await waitFor(async () => (await readVersions(storage.db, documentId, 2)).length > 0),
    ).toBe(true);

    const rows = await rowsOf(documentId);
    expect(await contentOf(rows[1]!)).toBe('erst dann');

    // The look back: the old base plus its own changes still shows the old state.
    expect(await contentOf(rows[0]!)).toBe('erst');

    await alice.close();
  });

  it('shows a client joining afterwards the same content', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'inhalt');

    expect(
      await waitFor(async () => (await readVersions(storage.db, documentId, 1)).length > 0),
    ).toBe(true);
    await hub.markVersion(documentId, { actorId: 'alice', label: 'Zwischenstand' });
    await alice.close();

    expect(await waitFor(() => gateway.countFor(documentId.toHexString()) === 0)).toBe(true);

    const bob = await open(documentId, 'bob');
    await bob.synced;
    expect(await waitFor(() => bob.doc.getText('t').toString() === 'inhalt')).toBe(true);
    await bob.close();
  });

  it('loses nothing when a change arrives in the same moment', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;

    alice.doc.getText('t').insert(0, 'vorher');
    const marking = hub.markVersion(documentId, { actorId: 'alice', label: 'gleichzeitig' });
    alice.doc.getText('t').insert(6, ' nachher');
    await marking;

    await alice.close();
    expect(await waitFor(() => gateway.countFor(documentId.toHexString()) === 0)).toBe(true);

    const bob = await open(documentId, 'bob');
    await bob.synced;
    expect(await waitFor(() => bob.doc.getText('t').toString() === 'vorher nachher')).toBe(true);
    await bob.close();
  });

  it('works on a document nobody has open and does not keep it open', async () => {
    const documentId = await freshDocument();
    const alice = await open(documentId, 'alice');
    await alice.synced;
    alice.doc.getText('t').insert(0, 'geschlossen');
    expect(
      await waitFor(async () => (await readVersions(storage.db, documentId, 1)).length > 0),
    ).toBe(true);
    await alice.close();
    expect(await waitFor(() => gateway.countFor(documentId.toHexString()) === 0)).toBe(true);

    const marked = await hub.markVersion(documentId, { actorId: 'carol', label: 'nachträglich' });

    expect(marked.version).toBe(2);
    expect(await contentOf(marked)).toBe('geschlossen');
    expect(gateway.countFor(documentId.toHexString())).toBe(0);
  });

  it('counts up with every further version', async () => {
    const documentId = await freshDocument();

    expect((await hub.markVersion(documentId, { actorId: 'alice' })).version).toBe(2);
    expect((await hub.markVersion(documentId, { actorId: 'alice' })).version).toBe(3);

    const rows = await rowsOf(documentId);
    expect(rows.map((row) => row.isCurrent)).toEqual([false, false, true]);
  });
});
