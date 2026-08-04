// Punkt 3 — Change-Feed: appendChangeLog (Insert-Mapping) + GET /changes (DB gemockt).
import request from 'supertest';

jest.mock('../config/db', () => ({ db: { query: jest.fn(), connect: jest.fn() }, connectDB: jest.fn() }));
jest.mock('../config/redis', () => ({
  redis: { publish: jest.fn(), set: jest.fn(), del: jest.fn(), getBuffer: jest.fn(), scan: jest.fn().mockResolvedValue(['0', []]), ping: jest.fn() },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: { subscribe: jest.fn().mockResolvedValue(undefined), on: jest.fn(), unsubscribe: jest.fn() },
}));

import { db } from '../config/db';
import { app } from '../app';
import { appendChangeLog } from '../services/changelog/changelog.service';

const mockQuery = db.query as jest.Mock;
beforeEach(() => jest.clearAllMocks());

describe('Punkt 3 — appendChangeLog', () => {
  it('schreibt einen semantic_conflict mit severity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await appendChangeLog('s1', {
      type: 'semantic_conflict',
      payload: {
        sessionId: 's1', who: { userId: 'bob', name: 'Bob' }, what: 'delete',
        where: { index: 5, length: 8 }, when: '2026-06-17T10:00:00.000Z',
        severity: 'warning', victim: { userId: 'alice' },
      },
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO change_log');
    // Reihenfolge: session, who, name, what, target, index, length, element, edge, field, severity, when
    expect(params).toEqual(['s1', 'bob', 'Bob', 'delete', 'text', 5, 8, null, null, null, 'warning', '2026-06-17T10:00:00.000Z']);
  });

  it('schreibt einen change_awareness-Feed mit severity null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await appendChangeLog('s1', {
      type: 'change_awareness',
      payload: { sessionId: 's1', who: { userId: 'alice' }, what: 'insert', where: { index: 0, length: 3 }, when: '2026-06-17T10:01:00.000Z' },
    });
    expect(mockQuery.mock.calls[0][1]).toEqual(['s1', 'alice', null, 'insert', 'text', 0, 3, null, null, null, null, '2026-06-17T10:01:00.000Z']);
  });

  it('schreibt ein MODELL-Event mit target=model + elementId (index/length null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await appendChangeLog('s1', {
      type: 'semantic_conflict',
      payload: {
        sessionId: 's1', who: { userId: 'bob' }, what: 'node.deleted',
        where: { target: 'model', elementId: 't1' }, when: '2026-06-17T10:02:00.000Z',
        severity: 'warning', victim: { userId: 'alice' },
      },
    });
    expect(mockQuery.mock.calls[0][1]).toEqual(['s1', 'bob', null, 'node.deleted', 'model', null, null, 't1', null, null, 'warning', '2026-06-17T10:02:00.000Z']);
  });

  it('wirft nie (defensiv) bei DB-Fehler', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(appendChangeLog('s1', {
      type: 'change_awareness',
      payload: { sessionId: 's1', who: { userId: 'a' }, what: 'insert', where: { index: 0, length: 1 }, when: 'x' },
    })).resolves.toBeUndefined();
  });
});

describe('Punkt 3 — GET /api/sessions/:id/changes', () => {
  it('liefert ChangeRecords (neueste zuerst), severity nur wenn gesetzt', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: 'c1', who_user_id: 'bob', who_name: 'Bob', what: 'delete', where_index: 5, where_length: 8, severity: 'warning', why_kind: null, why_ref: null, created_at: new Date('2026-06-17T10:00:00.000Z') },
      { id: 'c2', who_user_id: 'alice', who_name: null, what: 'insert', where_index: 0, where_length: 3, severity: null, why_kind: 'comment', why_ref: 'cmt-1', created_at: new Date('2026-06-17T09:59:00.000Z') },
    ] });
    const res = await request(app).get('/api/sessions/s1/changes');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ id: 'c1', sessionId: 's1', who: { userId: 'bob', name: 'Bob' }, what: 'delete', where: { index: 5, length: 8 }, when: '2026-06-17T10:00:00.000Z', severity: 'warning' });
    expect(res.body[1].severity).toBeUndefined();
    expect(res.body[1].who).toEqual({ userId: 'alice' });
    expect(res.body[1].why).toEqual({ kind: 'comment', refId: 'cmt-1' });   // A3
  });

  it('PATCH …/changes/:cid/why verknüpft eine Begründungsquelle', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: 'c1', who_user_id: 'bob', who_name: 'Bob', what: 'delete', where_index: 5, where_length: 8, severity: 'warning', why_kind: 'review', why_ref: 'rev-9', created_at: new Date('2026-06-17T10:00:00.000Z') },
    ] });
    const res = await request(app).patch('/api/sessions/s1/changes/c1/why').send({ kind: 'review', refId: 'rev-9' });
    expect(res.status).toBe(200);
    expect(res.body.why).toEqual({ kind: 'review', refId: 'rev-9' });
  });

  it('PATCH …/why lehnt ungültiges kind ab (400)', async () => {
    const res = await request(app).patch('/api/sessions/s1/changes/c1/why').send({ kind: 'x', refId: 'r' });
    expect(res.status).toBe(400);
  });

  it('?since_last_visit=true ermittelt zuerst last_seen_at, dann die Änderungen', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ last_seen_at: new Date('2026-06-17T08:00:00.000Z') }] }) // getLastVisit
      .mockResolvedValueOnce({ rows: [] });                                                       // getChanges
    const res = await request(app).get('/api/sessions/s1/changes?since_last_visit=true');
    expect(res.status).toBe(200);
    // getChanges-SQL muss den since-Filter enthalten
    const changesCall = mockQuery.mock.calls[1];
    expect(changesCall[0]).toContain('created_at >');
    expect(changesCall[1]).toContain('2026-06-17T08:00:00.000Z');
  });
});
