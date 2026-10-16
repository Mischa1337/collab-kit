import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import type { ObjectId } from 'mongodb';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CollabKitError,
  type Conflict,
  type OpenOptions,
  type Session,
  type TextDelta,
  type TextPosition,
} from '../../client/src/api.ts';
import { createCollabKitApi } from '../../client/src/index.ts';
import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { setGrant, type GrantChange } from '../../src/db/collections/grants.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { addToRoom, createRoom } from '../../src/db/collections/rooms.ts';
import { readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import {
  attachGateway,
  createWorkpieceHub,
  type Gateway,
  type WorkpieceHub,
} from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';
import { waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_client_text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;
let hub: WorkpieceHub;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let url: string;

const tokenOf = (actor: string) =>
  jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' });

/** Gives a group these rights at the room, in place of what it held there. */
const grant = (groupId: ObjectId, roomId: ObjectId, rights: GrantChange['rights']) =>
  setGrant(storage.db, { groupId, scope: { kind: 'room', id: roomId }, rights, setBy: 'alice' });

/** A workpiece holding units in units: alice and bob write, erin reads. */
async function freshWorkpiece(): Promise<ObjectId> {
  const workpiece = await createWorkpiece(storage.db, {
    name: 'Notizen',
    createdBy: 'alice',
    units: [{ path: ['units'] }],
  });
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  await addToRoom(storage.db, room._id, { workpieceId: workpiece._id, addedBy: 'alice' });
  const writers = await createGroup(storage.db, {
    name: 'Schreibende',
    createdBy: 'alice',
    members: ['alice', 'bob'],
  });
  const readers = await createGroup(storage.db, {
    name: 'Lesende',
    createdBy: 'alice',
    members: ['erin'],
  });
  await grant(writers._id, room._id, ['see', 'edit']);
  await grant(readers._id, room._id, ['see']);
  return workpiece._id;
}

// Every session a test opens, closed after it.
const opened: Session[] = [];

/** Opens a session as this person, as a tool would. */
function open(actor: string, workpieceId: ObjectId, options?: OpenOptions): Session {
  const session = createCollabKitApi({ url, getToken: () => tokenOf(actor) }).open(
    workpieceId.toHexString(),
    options,
  );
  opened.push(session);
  return session;
}

/** Opens sessions as these people, one each, and waits until all of them are in. */
async function together<const Actors extends readonly string[]>(
  workpieceId: ObjectId,
  ...actors: Actors
): Promise<{ [Index in keyof Actors]: Session }> {
  const sessions = actors.map((actor) => open(actor, workpieceId));
  await Promise.all(sessions.map((session) => session.synced));
  return sessions as { [Index in keyof Actors]: Session };
}

/** Waits until this many changes of the workpiece are stored. */
const stored = async (workpieceId: ObjectId, count: number) =>
  expect(
    await waitFor(async () => (await readUpdatesSince(storage.db, workpieceId)).length === count),
  ).toBe(true);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a call throws, to look at more than its message. */
function thrownBy(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  hub = createWorkpieceHub({ db: storage.db, logger: silent });
  const checkToken = createTokenCheck({ key: secret, algorithm: 'HS256' });
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
});

afterEach(() => {
  for (const session of opened.splice(0)) {
    session.close();
  }
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await storage.db.dropDatabase();
  await storage.close();
});

describe('changes to a text', () => {
  it('brings an insert to the other session, own here and not there', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice, bob] = await together(workpieceId, 'alice', 'bob');
    const seenByAlice: [TextDelta, boolean][] = [];
    const seenByBob: [TextDelta, boolean][] = [];
    alice.text('notes').onChange((delta, own) => seenByAlice.push([delta, own]));
    bob.text('notes').onChange((delta, own) => seenByBob.push([delta, own]));

    alice.text('notes').update([{ insert: 'hallo' }]);

    expect(await waitFor(() => bob.text('notes').value === 'hallo')).toBe(true);
    expect(seenByAlice).toEqual([[[{ insert: 'hallo' }], true]]);
    expect(seenByBob).toEqual([[[{ insert: 'hallo' }], false]]);
  });

  it('keeps both inputs typed apart at the same place, without a conflict', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice, bob] = await together(workpieceId, 'alice', 'bob');
    const conflicts: Conflict[] = [];
    alice.on('conflict', (conflict) => conflicts.push(conflict));
    bob.on('conflict', (conflict) => conflicts.push(conflict));
    alice.text('t').update([{ insert: 'ab' }]);
    expect(await waitFor(() => bob.text('t').value === 'ab')).toBe(true);

    // Both type between a and b, neither knowing of the other.
    alice.disconnect();
    alice.text('t').update([{ retain: 1 }, { insert: 'A' }]);
    bob.text('t').update([{ retain: 1 }, { insert: 'B' }]);
    await stored(workpieceId, 2);
    alice.connect();

    expect(
      await waitFor(
        () => alice.text('t').value.length === 4 && alice.text('t').value === bob.text('t').value,
      ),
    ).toBe(true);
    expect(alice.text('t').value).toMatch(/^a(AB|BA)b$/);
    await pause(200);
    expect(conflicts).toEqual([]);
  });

  it('brings attributes across, and delta gives them to whoever loads later', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice, bob] = await together(workpieceId, 'alice', 'bob');
    const content = [{ insert: 'fett', attributes: { bold: true } }, { insert: ' normal' }];

    alice.text('t').update(content);

    expect(await waitFor(() => bob.text('t').value === 'fett normal')).toBe(true);
    expect(bob.text('t').delta()).toEqual(content);
    const [later] = await together(workpieceId, 'erin');
    expect(later.text('t').delta()).toEqual(content);
  });

  it('tells nothing visible when formatting meets a letter already deleted', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice, bob] = await together(workpieceId, 'alice', 'bob');
    alice.text('t').update([{ insert: 'abcdef' }]);
    expect(await waitFor(() => bob.text('t').value === 'abcdef')).toBe(true);
    const seenByBob: [TextDelta, boolean][] = [];
    bob.text('t').onChange((delta, own) => seenByBob.push([delta, own]));

    // Alice makes c bold while away, bob deletes it.
    alice.disconnect();
    alice.text('t').update([{ retain: 2 }, { retain: 1, attributes: { bold: true } }]);
    bob.text('t').update([{ retain: 2 }, { delete: 1 }]);
    await stored(workpieceId, 2);
    alice.connect();

    expect(await waitFor(() => alice.text('t').value === 'abdef')).toBe(true);
    await pause(200);
    expect(seenByBob[0]).toEqual([[{ retain: 2 }, { delete: 1 }], true]);
    // Alice's copy tidies up her marks; Yjs may tell bob of a bold that was never set as removed.
    for (const [delta, own] of seenByBob.slice(1)) {
      expect(own).toBe(false);
      expect(delta.every((op) => 'retain' in op && op.attributes?.['bold'] !== true)).toBe(true);
    }
    for (const text of [alice.text('t'), bob.text('t')]) {
      expect(text.value).toBe('abdef');
      expect(text.delta().some((op) => 'attributes' in op)).toBe(false);
    }
  });

  it('sends on connect what was typed while disconnected', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice, bob] = await together(workpieceId, 'alice', 'bob');

    alice.disconnect();
    alice.text('t').update([{ insert: 'unterwegs' }]);
    await pause(200);
    expect(bob.text('t').value).toBe('');
    alice.connect();

    expect(await waitFor(() => bob.text('t').value === 'unterwegs')).toBe(true);
  });
});

describe('cursors', () => {
  it('moves a place along when the other inserts before it, read on either side', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice, bob] = await together(workpieceId, 'alice', 'bob');
    alice.text('t').update([{ insert: 'abcdef' }]);
    expect(await waitFor(() => bob.text('t').value === 'abcdef')).toBe(true);

    // Before d, sent through presence as JSON.
    const place = JSON.parse(JSON.stringify(bob.text('t').cursor(3))) as TextPosition;
    alice.text('t').update([{ insert: 'XY' }]);

    expect(await waitFor(() => bob.text('t').value === 'XYabcdef')).toBe(true);
    expect(bob.text('t').indexOf(place)).toBe(5);
    expect(alice.text('t').indexOf(place)).toBe(5);
    expect(bob.text('other').indexOf(place)).toBeUndefined();
  });
});

describe('anchors', () => {
  it('keeps a passage while others type before it, at its edges and inside', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice, bob] = await together(workpieceId, 'alice', 'bob');
    const text = alice.text('t');
    text.update([{ insert: 'abcdef' }]);

    // cde, through CK as the anchor of an event, as a comment would carry it.
    const ck = createCollabKitApi({ url, getToken: () => tokenOf('alice') });
    const sent = text.anchor(2, 3);
    const { anchor } = await ck.events.create({ kind: 'visit', anchor: sent });
    expect(anchor).toEqual(sent);
    expect(text.rangeOf(anchor)).toEqual({ index: 2, length: 3 });

    text.update([{ insert: 'XY' }]);
    expect(text.rangeOf(anchor)).toEqual({ index: 4, length: 3 });
    // Typed right at the start or the end, it stays outside.
    text.update([{ retain: 4 }, { insert: '1' }]);
    text.update([{ retain: 8 }, { insert: '2' }]);
    expect(text.value).toBe('XYab1cde2f');
    expect(text.rangeOf(anchor)).toEqual({ index: 5, length: 3 });
    // Typed inside, the passage grows.
    text.update([{ retain: 6 }, { insert: '3' }]);
    expect(text.rangeOf(anchor)).toEqual({ index: 5, length: 4 });

    expect(await waitFor(() => bob.text('t').value === 'XYab1c3de2f')).toBe(true);
    expect(bob.text('t').rangeOf(anchor)).toEqual({ index: 5, length: 4 });

    // Deleted whole, a point is left where it stood.
    text.update([{ retain: 5 }, { delete: 4 }]);
    expect(text.rangeOf(anchor)).toEqual({ index: 5, length: 0 });
  });

  it('holds a point without length, and finds nothing for any other anchor', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice] = await together(workpieceId, 'alice');
    const text = alice.text('t');
    text.update([{ insert: 'abc' }]);

    const point = text.anchor(1);
    text.update([{ insert: 'X' }]);
    expect(text.rangeOf(point)).toEqual({ index: 2, length: 0 });

    const anchor = text.anchor(1, 1);
    expect(alice.text('other').rangeOf(anchor)).toBeUndefined();
    expect(text.rangeOf({ ...anchor, id: '0123456789abcdef01234567' })).toBeUndefined();
    expect(text.rangeOf({ ...anchor, kind: 'room' })).toBeUndefined();
    expect(text.rangeOf({ kind: 'workpiece', id: anchor.id })).toBeUndefined();
    expect(text.rangeOf({ ...anchor, unit: 'cell-1' })).toBeUndefined();
    expect(text.rangeOf({ ...anchor, unit: '{"start":1}' })).toBeUndefined();
  });
});

describe('undo', () => {
  it('takes back only the own input, which arrives with own false', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice, bob] = await together(workpieceId, 'alice', 'bob');
    alice.text('t').update([{ insert: 'von alice' }]);
    expect(await waitFor(() => bob.text('t').value === 'von alice')).toBe(true);
    bob.text('t').update([{ retain: 9 }, { insert: ' und bob' }]);
    expect(await waitFor(() => alice.text('t').value === 'von alice und bob')).toBe(true);
    const own: boolean[] = [];
    alice.text('t').onChange((_delta, isOwn) => own.push(isOwn));
    const steps = () => [alice.text('t').canUndo(), alice.text('t').canRedo()];
    expect(steps()).toEqual([true, false]);

    expect(alice.text('t').undo()).toBe(true);

    expect(alice.text('t').value).toBe(' und bob');
    expect(own).toEqual([false]);
    expect(steps()).toEqual([false, true]);
    expect(await waitFor(() => bob.text('t').value === ' und bob')).toBe(true);
    expect(alice.text('t').undo()).toBe(false);
    expect(alice.text('t').redo()).toBe(true);
    expect(alice.text('t').value).toBe('von alice und bob');
    expect(steps()).toEqual([true, false]);
  });

  it('keeps an update with undoable false out of undo, and it stays own', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice] = await together(workpieceId, 'alice');
    const own: boolean[] = [];
    alice.text('t').onChange((_delta, isOwn) => own.push(isOwn));

    alice.text('t').update([{ insert: 'geladen' }], { undoable: false });

    expect(own).toEqual([true]);
    expect(alice.text('t').canUndo()).toBe(false);
    expect(alice.text('t').undo()).toBe(false);
    expect(alice.text('t').value).toBe('geladen');
  });
});

describe('rights, names and ends', () => {
  it('throws 403 for update, undo and redo without edit, and stays connected', async () => {
    const workpieceId = await freshWorkpiece();
    const [erin] = await together(workpieceId, 'erin');
    const notes = erin.text('t');

    for (const call of [
      () => notes.update([{ insert: 'x' }]),
      () => notes.undo(),
      () => notes.redo(),
    ]) {
      expect(thrownBy(call)).toMatchObject({ name: 'CollabKitError', status: 403 });
    }
    expect(erin.status).toBe('connected');
  });

  it('throws 1000 after close for text, update and undo', async () => {
    const workpieceId = await freshWorkpiece();
    const [alice] = await together(workpieceId, 'alice');
    const notes = alice.text('t');
    alice.close();

    for (const call of [
      () => alice.text('t'),
      () => notes.update([{ insert: 'x' }]),
      () => notes.undo(),
    ]) {
      expect(thrownBy(call)).toMatchObject({ name: 'CollabKitError', status: 1000 });
    }
  });

  it('gives the same object for a name, and refuses the name of the units', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = open('alice', workpieceId);
    const cells = open('alice', workpieceId, { map: 'cells' });

    expect(alice.text('notes')).toBe(alice.text('notes'));
    for (const error of [
      thrownBy(() => alice.text('units')),
      thrownBy(() => cells.text('cells')),
    ]) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CollabKitError);
    }
    expect(cells.text('units').value).toBe('');
  });
});

describe('text beside units', () => {
  it('keeps both apart, in one session and as two sessions at two workpieces', async () => {
    const modelId = await freshWorkpiece();
    const notesId = await freshWorkpiece();
    const [alice, bob] = await together(modelId, 'alice', 'bob');

    alice.units.update({ set: { a: 1 } });
    alice.text('notes').update([{ insert: 'zu a' }]);
    expect(
      await waitFor(() => bob.units.get('a') === 1 && bob.text('notes').value === 'zu a'),
    ).toBe(true);
    expect(bob.units.entries()).toEqual([['a', 1]]);

    // The notes in a workpiece of their own, each person with a second session.
    const [aliceNotes, bobNotes] = await together(notesId, 'alice', 'bob');
    aliceNotes.text('notes').update([{ insert: 'eigene Notizen' }]);

    expect(await waitFor(() => bobNotes.text('notes').value === 'eigene Notizen')).toBe(true);
    expect(bob.text('notes').value).toBe('zu a');
    expect(bobNotes.units.entries()).toEqual([]);
  });
});
