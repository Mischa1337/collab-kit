// M17 — Notifications: REST-API + Empfänger-Logik der Event-Helfer.
// DB und Redis werden gemockt — kein laufender Docker nötig.
import request from 'supertest';
import { app } from '../app';
import { db } from '../config/db';

jest.mock('../config/db', () => ({
  db: { query: jest.fn() },
}));

jest.mock('../config/redis', () => ({
  redis: { publish: jest.fn().mockResolvedValue(1) },
  subscriber: { on: jest.fn(), psubscribe: jest.fn().mockResolvedValue(undefined) },
  connectRedis: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/websocket/controller', () => ({
  broadcastToSession: jest.fn(),
}));

// Event-Helfer werden hier ECHT getestet (gegen die gemockte DB).
import { extractMentions, notifyMentions, notifyNewComment, notifyReviewFeedback } from '../services/notifications/notification.service';

const USER = 'dev-user'; // authMiddleware-Fallback im Test (kein AUTH_SERVICE_URL gesetzt)

beforeEach(() => {
  (db.query as jest.Mock).mockReset();
});

describe('M17 — Notifications REST-API', () => {
  it('GET /api/notifications gibt die eigenen Benachrichtigungen zurück', async () => {
    const FAKE = { id: 'n1', user_id: USER, session_id: 's1', type: 'new_comment', ref_id: 'c1', read_at: null, created_at: '2026-06-01T00:00:00.000Z' };
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE] });

    const res = await request(app).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('n1');
    expect((db.query as jest.Mock).mock.calls[0][1]).toContain(USER); // user_id-Filter
  });

  it('GET /api/notifications?unread=true filtert auf ungelesene', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/notifications?unread=true');

    expect((db.query as jest.Mock).mock.calls[0][0]).toEqual(expect.stringContaining('read_at IS NULL'));
  });

  it('GET /api/notifications/unread-count liefert die Anzahl', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ count: 3 }] });

    const res = await request(app).get('/api/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
  });

  it('POST /api/notifications/:id/read markiert als gelesen (200)', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'n1', user_id: USER, read_at: '2026-06-02T00:00:00.000Z' }] });

    const res = await request(app).post('/api/notifications/n1/read');

    expect(res.status).toBe(200);
    expect(res.body.read_at).not.toBeNull();
  });

  it('POST /api/notifications/:id/read gibt 404 wenn nicht gefunden / nicht eigen / schon gelesen', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/notifications/n1/read');

    expect(res.status).toBe(404);
  });

  it('POST /api/notifications/read-all gibt die Anzahl aktualisierter zurück', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rowCount: 5 });

    const res = await request(app).post('/api/notifications/read-all');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 5 });
  });
});

describe('M17 — Event-Helfer (Empfänger-Logik)', () => {
  it('notifyReviewFeedback benachrichtigt den Anfragenden', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'n1' }] }); // INSERT

    await notifyReviewFeedback({ id: 'r1', session_id: 's1', requester_id: 'alice' }, 'bob');

    expect(db.query).toHaveBeenCalledTimes(1);
    expect((db.query as jest.Mock).mock.calls[0][1]).toEqual(expect.arrayContaining(['alice', 's1', 'review_feedback']));
  });

  it('notifyReviewFeedback benachrichtigt NICHT bei Selbst-Review (requester === author)', async () => {
    await notifyReviewFeedback({ id: 'r1', session_id: 's1', requester_id: 'alice' }, 'alice');

    expect(db.query).not.toHaveBeenCalled();
  });

  it('notifyNewComment benachrichtigt den Session-Ersteller (≠ Autor)', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ created_by: 'creator' }] }) // SELECT created_by
      .mockResolvedValueOnce({ rows: [{ id: 'n1' }] });             // INSERT

    await notifyNewComment({ id: 'c1', session_id: 's1', author_id: 'someone', parent_id: null });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect((db.query as jest.Mock).mock.calls[1][1]).toEqual(expect.arrayContaining(['creator', 's1', 'new_comment']));
  });

  it('notifyNewComment benachrichtigt NICHT wenn der Autor selbst der Ersteller ist', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ created_by: 'me' }] });

    await notifyNewComment({ id: 'c1', session_id: 's1', author_id: 'me', parent_id: null });

    expect(db.query).toHaveBeenCalledTimes(1); // nur SELECT, kein INSERT
  });
});

describe('M18 — @-Erwähnungen', () => {
  it('extractMentions findet eindeutige @-Token', () => {
    expect(extractMentions('Hi @u-alice und @u-bob, cc @u-alice')).toEqual(['u-alice', 'u-bob']);
  });

  it('extractMentions gibt [] zurück ohne Erwähnungen', () => {
    expect(extractMentions('kein Ping hier')).toEqual([]);
  });

  it('notifyMentions benachrichtigt jeden genannten Nutzer (außer den Autor)', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'n1' }] }); // ein INSERT für u-bob

    await notifyMentions({
      id: 'c1', session_id: 's1', author_id: 'u-alice', parent_id: null,
      content: '@u-bob bitte schauen, @u-alice ignoriert sich selbst',
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect((db.query as jest.Mock).mock.calls[0][1]).toEqual(expect.arrayContaining(['u-bob', 's1', 'mention']));
  });
});

describe('M17-Extra — Seit letztem Besuch & Digest', () => {
  it('POST /api/sessions/:id/seen upsertet und gibt 204', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app).post('/api/sessions/s1/seen');

    expect(res.status).toBe(204);
  });

  it('GET /api/sessions/:id/since-last-visit liefert die Zähler (eigene Aktivität ausgeschlossen)', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ last_seen_at: '2026-06-01T00:00:00.000Z' }] }) // SELECT last_seen
      .mockResolvedValueOnce({ rows: [{ c: 2 }] })  // comments
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })  // versions
      .mockResolvedValueOnce({ rows: [{ c: 0 }] }); // reviews

    const res = await request(app).get('/api/sessions/s1/since-last-visit');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      last_seen_at: '2026-06-01T00:00:00.000Z',
      new_comments: 2,
      new_versions: 1,
      new_reviews: 0,
    });
  });

  it('GET /api/notifications/digest fasst ungelesene nach Typ zusammen', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ type: 'new_comment' }, { type: 'new_comment' }, { type: 'mention' }],
    });

    const res = await request(app).get('/api/notifications/digest');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.lines).toEqual(expect.arrayContaining(['2× new_comment', '1× mention']));
  });

  it('GET /api/notifications/digest meldet count 0 ohne Ungelesene', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/notifications/digest');

    expect(res.body.count).toBe(0);
  });
});
