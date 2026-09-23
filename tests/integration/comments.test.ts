import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WHOLE } from '../../src/model/anchor.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import {
  createComment,
  findComment,
  readComments,
  ROOT,
  setCommentState,
} from '../../src/db/collections/comments.ts';
import { readEvents } from '../../src/db/collections/events.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_comments_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;
let documentId: ObjectId;

const on = (unit?: unknown) => ({
  kind: 'document',
  id: documentId,
  ...(unit === undefined ? {} : { unit }),
});

const said = (over: Partial<Parameters<typeof createComment>[1]> = {}) =>
  createComment(storage.db, {
    kind: 'comment',
    anchor: on(),
    actorId: 'alice',
    body: { text: 'so wie es dasteht geht das nicht' },
    ...over,
  });

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

describe('saying something', () => {
  it('keeps what was said and where, and nothing more', async () => {
    const created = await said();

    expect(created).toMatchObject({ kind: 'comment', actorId: 'alice' });
    expect(created.parentId).toBeUndefined();
    expect(created.state).toBeUndefined();
  });

  it('keeps the body untouched, whatever shape it has', async () => {
    const body = {
      text: 'zwei Sachen',
      punkte: [1, 2],
      verschachtelt: { schwere: 'hoch', markiert: true },
    };
    const created = await said({ body });

    expect((await findComment(storage.db, created._id))?.body).toEqual(body);
  });

  it('sticks to a place inside the document when it carries a unit', async () => {
    const created = await said({ anchor: on('statement-3') });

    expect((await findComment(storage.db, created._id))?.anchor).toEqual({
      kind: 'document',
      id: documentId,
      unit: 'statement-3',
    });
  });

  it('points at another comment just as well, which is what a thread is', async () => {
    const first = await said();
    const answer = await said({
      actorId: 'bob',
      parentId: first._id,
      anchor: { kind: 'comment', id: first._id },
      body: { text: 'sehe ich anders' },
    });

    expect(answer.parentId).toEqual(first._id);
    expect(answer.anchor.kind).toBe('comment');
  });

  it('answers with null for a comment nobody wrote', async () => {
    await expect(findComment(storage.db, new ObjectId())).resolves.toBeNull();
  });
});

describe('the state of a piece of feedback', () => {
  it('moves and keeps who moved it', async () => {
    const comment = await said({ state: 'offen' });

    const after = await setCommentState(storage.db, comment._id, {
      state: 'umgesetzt',
      actorId: 'bob',
      reason: 'im Entwurf nachgezogen',
    });

    expect(after.state).toBe('umgesetzt');
    expect((await findComment(storage.db, comment._id))?.state).toBe('umgesetzt');

    const [event] = await readEvents(storage.db, {
      anchor: { kind: 'comment', id: comment._id },
    });
    expect(event).toMatchObject({
      kind: 'comment-state',
      actorId: 'bob',
      reason: 'im Entwurf nachgezogen',
      detail: { to: 'umgesetzt' },
    });
  });

  it('keeps every step of the five, not only the last', async () => {
    const comment = await said({ state: 'offen' });

    await setCommentState(storage.db, comment._id, { state: 'gelesen', actorId: 'carol' });
    await setCommentState(storage.db, comment._id, { state: 'beantwortet', actorId: 'carol' });
    await setCommentState(storage.db, comment._id, { state: 'umgesetzt', actorId: 'carol' });

    const history = await readEvents(storage.db, { anchor: { kind: 'comment', id: comment._id } });
    expect(history.map((event) => event.detail?.['to'])).toEqual([
      'umgesetzt',
      'beantwortet',
      'gelesen',
    ]);
  });

  it('refuses a comment nobody wrote', async () => {
    await expect(
      setCommentState(storage.db, new ObjectId(), { state: 'gelesen', actorId: 'alice' }),
    ).rejects.toThrowError(/unknown comment/);
  });
});

describe('reading back', () => {
  it('gives everything about the document, the local ones included', async () => {
    await said({ body: { text: 'global' } });
    await said({ anchor: on('statement-3'), body: { text: 'lokal' } });

    await expect(readComments(storage.db, { anchor: on() })).resolves.toHaveLength(2);
  });

  it('separates local from global', async () => {
    await said({ body: { text: 'global' } });
    await said({ anchor: on('statement-3'), body: { text: 'lokal' } });

    const global = await readComments(storage.db, { anchor: on(WHOLE) });
    expect(global.map((comment) => comment.body['text'])).toEqual(['global']);

    const local = await readComments(storage.db, { anchor: on('statement-3') });
    expect(local.map((comment) => comment.body['text'])).toEqual(['lokal']);
  });

  it('reads a thread forwards, oldest first', async () => {
    const first = await said({ body: { text: 'eins' } });
    await said({ parentId: first._id, body: { text: 'zwei' } });
    await said({ parentId: first._id, body: { text: 'drei' } });

    const answers = await readComments(storage.db, { parentId: first._id });
    expect(answers.map((comment) => comment.body['text'])).toEqual(['zwei', 'drei']);
  });

  it('gives only the starts of the threads when asked for them', async () => {
    const first = await said({ body: { text: 'eins' } });
    await said({ parentId: first._id, body: { text: 'antwort' } });

    const starts = await readComments(storage.db, { anchor: on(), parentId: ROOT });
    expect(starts.map((comment) => comment.body['text'])).toEqual(['eins']);
  });

  it('narrows by kind, by state and by who said it', async () => {
    await said({ kind: 'feedback', state: 'offen' });
    await said({ kind: 'feedback', state: 'umgesetzt', actorId: 'bob' });
    await said({ kind: 'message' });

    await expect(
      readComments(storage.db, { anchor: on(), kind: 'feedback' }),
    ).resolves.toHaveLength(2);
    await expect(readComments(storage.db, { anchor: on(), state: 'offen' })).resolves.toHaveLength(
      1,
    );
    await expect(readComments(storage.db, { anchor: on(), actorId: 'bob' })).resolves.toHaveLength(
      1,
    );
  });

  it('keeps the comments of other documents out', async () => {
    await said();
    const mine = documentId;
    documentId = new ObjectId();

    await expect(readComments(storage.db, { anchor: on() })).resolves.toEqual([]);
    await expect(
      readComments(storage.db, { anchor: { kind: 'document', id: mine } }),
    ).resolves.toHaveLength(1);
  });
});
