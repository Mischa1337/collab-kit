// WP2 — Datenexport-Tests. DB und Redis gemockt.
import request from 'supertest';
import * as Y from 'yjs';
import { db } from '../config/db';
import { upsertNode } from '../services/collaboration/model.types';

jest.mock('../config/db', () => {
  const mockQuery = jest.fn();
  return { db: { query: mockQuery, connect: jest.fn() }, connectDB: jest.fn() };
});

jest.mock('../config/redis', () => ({
  redis: {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    getBuffer: jest.fn().mockResolvedValue(null),
    scan: jest.fn().mockResolvedValue(['0', []]),
    publish: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue('PONG'),
  },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: { subscribe: jest.fn().mockResolvedValue(undefined), on: jest.fn(), unsubscribe: jest.fn() },
}));

import { app } from '../app';

beforeEach(() => jest.clearAllMocks());

describe('WP2 — Session-Export', () => {
  it('GET /api/sessions/:id/export → 200 mit Dokument, Kommentaren, Reviews, History', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: 's1', name: 'Test', created_by: 'dev-user', created_at: 't' }] }) // session
      .mockResolvedValueOnce({ rows: [{ content_snapshot: null, version: 1, updated_at: 't' }] })            // document
      .mockResolvedValueOnce({ rows: [{ id: 'c1', author_id: 'dev-user', content: 'hi' }] })                  // comments
      .mockResolvedValueOnce({ rows: [{ id: 'r1', status: 'offen' }] })                                       // reviews
      .mockResolvedValueOnce({ rows: [{ id: 'h1', version_number: 1 }] });                                    // history

    const res = await request(app).get('/api/sessions/s1/export');
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe('s1');
    expect(res.body.document.text).toBe(''); // null-Snapshot → leerer Text
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.document.model).toEqual({ nodes: [], edges: [] }); // M11: leer bei null-Snapshot
    expect(res.body).toHaveProperty('exported_at');
  });

  it('GET /api/sessions/:id/export → enthält das Modell (M11) aus dem Snapshot', async () => {
    // Echten Whole-Doc-Snapshot mit einem Knoten bauen.
    const doc = new Y.Doc();
    upsertNode(doc, { id: 't1', type: 'table', label: 'Kunde', x: 0, y: 0 });
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc));

    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: 's1', name: 'Test', created_by: 'dev-user', created_at: 't' }] }) // session
      .mockResolvedValueOnce({ rows: [{ content_snapshot: snapshot, version: 2, updated_at: 't' }] })         // document
      .mockResolvedValueOnce({ rows: [] })                                                                    // comments
      .mockResolvedValueOnce({ rows: [] })                                                                    // reviews
      .mockResolvedValueOnce({ rows: [] });                                                                   // history

    const res = await request(app).get('/api/sessions/s1/export');
    expect(res.status).toBe(200);
    expect(res.body.document.model.nodes).toHaveLength(1);
    expect(res.body.document.model.nodes[0]).toMatchObject({ id: 't1', label: 'Kunde' });
  });

  it('GET /api/sessions/:id/export?format=md → Markdown mit Kommentaren', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: 's1', name: 'Test', created_by: 'dev-user', created_at: 't' }] })
      .mockResolvedValueOnce({ rows: [{ content_snapshot: null, version: 1, updated_at: 't' }] })
      .mockResolvedValueOnce({ rows: [{ content: 'hi', author_id: 'dev-user' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/sessions/s1/export?format=md');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/markdown/);
    expect(res.text).toContain('# Test');
    expect(res.text).toContain('## Kommentare');
  });

  it('GET /api/sessions/:id/export → 404 wenn Session fehlt', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/sessions/nope/export');
    expect(res.status).toBe(404);
  });
});

describe('WP2 — Nutzer-Export (DSGVO Art. 15)', () => {
  it('GET /api/me/export → 200 mit allen eigenen Daten', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ id: 's1', name: 'Meine Session' }] })       // sessions
      .mockResolvedValueOnce({ rows: [{ id: 'c1', content: 'x' }] })                // comments
      .mockResolvedValueOnce({ rows: [{ id: 'r1', status: 'offen' }] })            // reviews
      .mockResolvedValueOnce({ rows: [{ id: 'n1', type: 'mention' }] })            // notifications
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', last_seen_at: 't' }] })  // session_views
      .mockResolvedValueOnce({ rows: [{ id: 'm1', session_id: 's1', content: 'hi' }] }) // chat_messages
      .mockResolvedValueOnce({ rows: [{ id: 't1', session_id: 's1', title: 'Aufgabe', status: 'open' }] }) // tasks
      .mockResolvedValueOnce({ rows: [{ id: 'h1', session_id: 's1', version_number: 1, name: 'mein Stand', scope: 'personal', kind: 'manual' }] }) // saved_states
      .mockResolvedValueOnce({ rows: [{ id: 'f1', review_id: 'r1', feedback: 'gut', verdict: 'approved' }] }) // review_feedback
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', updated_at: 't' }] }); // drafts

    const res = await request(app).get('/api/me/export');
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe('dev-user');
    expect(res.body.sessions_created).toHaveLength(1);
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.session_views).toHaveLength(1);
    expect(res.body.chat_messages).toHaveLength(1);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.saved_states).toHaveLength(1);
    expect(res.body.review_feedback).toHaveLength(1);
    expect(res.body.drafts).toHaveLength(1);
    expect(res.body).toHaveProperty('exported_at');
  });
});
