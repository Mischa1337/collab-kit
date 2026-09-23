import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WHOLE } from '../../src/model/anchor.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { latestEvent, readEvents, recordEvent } from '../../src/db/collections/events.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_events_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;

/** A fresh document key per test, so the collection stays shared but the anchors do not. */
const on = (unit?: unknown) => ({
  kind: 'document',
  id: documentId,
  ...(unit === undefined ? {} : { unit }),
});

let documentId: ObjectId;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

beforeEach(() => {
  documentId = new ObjectId();
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

describe('recording what happened', () => {
  it('keeps an event without any of the optional parts', async () => {
    const created = await recordEvent(storage.db, {
      kind: 'presence',
      actorId: 'alice',
      anchor: on(),
    });

    expect(created).toMatchObject({ kind: 'presence', actorId: 'alice' });
    expect(created.at).toBeUndefined();
    expect(created.label).toBeUndefined();
    expect(created.reason).toBeUndefined();
  });

  it('keeps a checkpoint with its why', async () => {
    const at = new ObjectId();
    const created = await recordEvent(storage.db, {
      kind: 'checkpoint',
      actorId: 'carol',
      anchor: on(),
      at,
      label: 'Abgabe 1',
      reason: 'vor dem Umbau des Kundenteils',
    });

    expect(created).toMatchObject({ at, label: 'Abgabe 1' });
    expect(created.reason).toBe('vor dem Umbau des Kundenteils');
  });

  it('carries a unit of whatever shape, untouched', async () => {
    await recordEvent(storage.db, {
      kind: 'visit',
      actorId: 'alice',
      anchor: on({ row: 4, column: 'name' }),
      detail: { whatever: [1, 2, 3] },
    });

    const [stored] = await readEvents(storage.db, { anchor: on() });
    expect(stored?.anchor.unit).toEqual({ row: 4, column: 'name' });
    expect(stored?.detail).toEqual({ whatever: [1, 2, 3] });
  });
});

describe('reading back', () => {
  async function three(): Promise<void> {
    await recordEvent(storage.db, { kind: 'read', actorId: 'alice', anchor: on() });
    await recordEvent(storage.db, { kind: 'read', actorId: 'alice', anchor: on('statement-3') });
    await recordEvent(storage.db, { kind: 'visit', actorId: 'bob', anchor: on('statement-3') });
  }

  it('gives everything about the thing, unit-bound ones included', async () => {
    await three();

    const found = await readEvents(storage.db, { anchor: on() });
    expect(found).toHaveLength(3);
  });

  it('gives only the thing itself when asked for the whole', async () => {
    await three();

    const found = await readEvents(storage.db, { anchor: on(WHOLE) });
    expect(found.map((event) => event.kind)).toEqual(['read']);
  });

  it('narrows down to one unit', async () => {
    await three();

    const found = await readEvents(storage.db, { anchor: on('statement-3') });
    expect(found.map((event) => event.actorId).toSorted()).toEqual(['alice', 'bob']);
  });

  it('narrows down by actor and by kind', async () => {
    await three();

    await expect(readEvents(storage.db, { anchor: on(), actorId: 'bob' })).resolves.toHaveLength(1);
    await expect(readEvents(storage.db, { anchor: on(), kind: 'read' })).resolves.toHaveLength(2);
  });

  it('answers newest first and honours a limit', async () => {
    const first = await recordEvent(storage.db, { kind: 'read', actorId: 'a', anchor: on() });
    const second = await recordEvent(storage.db, { kind: 'read', actorId: 'b', anchor: on() });

    const found = await readEvents(storage.db, { anchor: on() });
    expect(found.map((event) => event._id)).toEqual([second._id, first._id]);

    const one = await readEvents(storage.db, { anchor: on(), limit: 1 });
    expect(one.map((event) => event._id)).toEqual([second._id]);
  });
});

describe('the newest of a kind', () => {
  it('is the reading mark, without anything being overwritten', async () => {
    const first = new ObjectId();
    const second = new ObjectId();

    await recordEvent(storage.db, { kind: 'read', actorId: 'bob', anchor: on(), at: first });
    await recordEvent(storage.db, { kind: 'read', actorId: 'bob', anchor: on(), at: second });

    const mark = await latestEvent(storage.db, {
      anchor: on(),
      actorId: 'bob',
      kind: 'read',
    });

    expect(mark?.at).toEqual(second);

    // Both are still there, which is the reading history D6.16 asks for.
    await expect(
      readEvents(storage.db, { anchor: on(), actorId: 'bob', kind: 'read' }),
    ).resolves.toHaveLength(2);
  });

  it('does not mix two people up', async () => {
    const hers = new ObjectId();
    await recordEvent(storage.db, { kind: 'read', actorId: 'alice', anchor: on(), at: hers });
    await recordEvent(storage.db, { kind: 'read', actorId: 'bob', anchor: on() });

    const mark = await latestEvent(storage.db, { anchor: on(), actorId: 'alice', kind: 'read' });
    expect(mark?.at).toEqual(hers);
  });

  it('answers with null when nothing of that kind happened', async () => {
    await expect(
      latestEvent(storage.db, { anchor: on(), actorId: 'dora', kind: 'read' }),
    ).resolves.toBeNull();
  });
});
