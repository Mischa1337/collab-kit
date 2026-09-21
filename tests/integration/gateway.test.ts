import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import pino from 'pino';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createDocument } from '../../src/db/documents.ts';
import { createGroup } from '../../src/db/groups.ts';
import { addToRoom, createRoom } from '../../src/db/rooms.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createDocumentHub } from '../../src/realtime/documents.ts';
import { attachGateway, type Gateway } from '../../src/realtime/gateway.ts';
import { createServer } from '../../src/server.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_gateway_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const token = jwt.sign({ sub: 'alice', name: 'Alice' }, secret, { expiresIn: '15m' });

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;
let documentId: string;

type Attempt = { ok: true; socket: WebSocket } | { ok: false; status: number };

function tryOpen(path: string, protocols: string[] = ['bearer', token]): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols);
    let settled = false;

    socket.on('open', () => {
      settled = true;
      resolve({ ok: true, socket });
    });
    socket.on('unexpected-response', (_request, response) => {
      settled = true;
      resolve({ ok: false, status: response.statusCode ?? 0 });
    });
    socket.on('error', (error) => {
      if (!settled) {
        reject(error);
      }
    });
  });
}

/**
 * The client is closed before the server has tidied up, so the count is awaited
 * instead of read straight away.
 */
async function waitForCount(expected: number, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  /* eslint-disable no-await-in-loop */
  while (gateway.countFor(documentId) !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  /* eslint-enable no-await-in-loop */

  return gateway.countFor(documentId);
}

function close(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.on('close', () => resolve());
    socket.close();
  });
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const document = await createDocument(storage.db, { name: 'Entwurf', createdBy: 'alice' });
  documentId = document._id.toHexString();

  // Opening needs a room that bundles the document and a group alice is in.
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  const group = await createGroup(storage.db, {
    name: 'Teilnehmende',
    createdBy: 'alice',
    members: ['alice'],
  });
  await addToRoom(storage.db, room._id, {
    kind: 'document',
    id: document._id,
    addedBy: 'alice',
  });
  await addToRoom(storage.db, room._id, { kind: 'group', id: group._id, addedBy: 'alice' });

  server = createServer({ logger: pino({ level: 'silent' }) });
  gateway = attachGateway({
    server,
    db: storage.db,
    hub: createDocumentHub({ db: storage.db, logger: pino({ level: 'silent' }) }),
    checkToken: createTokenCheck({ secret }),
    logger: pino({ level: 'silent' }),
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

describe('the handshake', () => {
  it('lets a valid token through and counts the connection', async () => {
    const attempt = await tryOpen(`/ws/${documentId}`);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;

    expect(gateway.countFor(documentId)).toBe(1);
    expect(attempt.socket.protocol).toBe('bearer');

    await close(attempt.socket);
    await expect(waitForCount(0)).resolves.toBe(0);
  });

  it('refuses a token from another secret with 401', async () => {
    const foreign = jwt.sign({ sub: 'mallory' }, 'anderes-geheimnis', { expiresIn: '15m' });

    await expect(tryOpen(`/ws/${documentId}`, ['bearer', foreign])).resolves.toEqual({
      ok: false,
      status: 401,
    });
  });

  it('refuses a handshake that offers no token', async () => {
    await expect(tryOpen(`/ws/${documentId}`, ['bearer'])).resolves.toEqual({
      ok: false,
      status: 401,
    });
  });

  it('refuses somebody who is in no group of the room with 403', async () => {
    const stranger = jwt.sign({ sub: 'mallory', name: 'Mallory' }, secret, { expiresIn: '15m' });

    await expect(tryOpen(`/ws/${documentId}`, ['bearer', stranger])).resolves.toEqual({
      ok: false,
      status: 403,
    });
  });

  it('answers an unknown document with 404', async () => {
    await expect(tryOpen('/ws/6aacfebc84651b67d9e70456')).resolves.toEqual({
      ok: false,
      status: 404,
    });
  });

  it('answers a malformed key with 400', async () => {
    await expect(tryOpen('/ws/kein-schluessel')).resolves.toEqual({ ok: false, status: 400 });
  });

  it('answers an unknown path with 404', async () => {
    await expect(tryOpen(`/sonstwo/${documentId}`)).resolves.toEqual({ ok: false, status: 404 });
  });

  it('holds two connections on the same document at once', async () => {
    const first = await tryOpen(`/ws/${documentId}`);
    const second = await tryOpen(`/ws/${documentId}`);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(gateway.countFor(documentId)).toBe(2);

    await close(first.socket);
    await expect(waitForCount(1)).resolves.toBe(1);

    await close(second.socket);
    await expect(waitForCount(0)).resolves.toBe(0);
  });
});
