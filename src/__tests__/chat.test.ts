// WP3 — Chat-Tests. DB/Redis gemockt; broadcastToSession → redis.publish.
import request from 'supertest';
import { redis } from '../config/redis';
import { db } from '../config/db';

jest.mock('../config/db', () => ({ db: { query: jest.fn(), connect: jest.fn() }, connectDB: jest.fn() }));

jest.mock('../config/redis', () => ({
  redis: {
    publish: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    getBuffer: jest.fn().mockResolvedValue(null),
    scan: jest.fn().mockResolvedValue(['0', []]),
    ping: jest.fn(),
  },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: { subscribe: jest.fn().mockResolvedValue(undefined), on: jest.fn(), unsubscribe: jest.fn() },
}));

import { app } from '../app';

beforeEach(() => jest.clearAllMocks());
afterEach(() => { delete process.env.DEV_ENFORCE_ROLES; }); // Rollen-Enforcement nach 403-Test zurücksetzen

describe('WP3 — Session-Chat', () => {
  it('POST /api/sessions/:id/chat → 200 und broadcastet chat.message', async () => {
    const res = await request(app).post('/api/sessions/s1/chat').send({ content: 'hallo team' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('hallo team');
    expect(res.body.user_id).toBe('dev-user');
    expect(typeof res.body.id).toBe('string'); // id für Referenzierung (z. B. Löschen)
    // broadcastToSession → redis.publish auf den Session-Kanal
    expect(redis.publish as jest.Mock).toHaveBeenCalledWith(
      'session:s1:events',
      expect.stringContaining('chat.message'),
    );
  });

  it('POST /api/sessions/:id/chat → 400 ohne content', async () => {
    const res = await request(app).post('/api/sessions/s1/chat').send({});
    expect(res.status).toBe(400);
  });

  it('GET /api/sessions/:id/chat → 200 mit Verlauf (C5)', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [
      { id: 'm1', session_id: 's1', user_id: 'dev-user', content: 'hallo', created_at: new Date('2026-06-17T10:00:00.000Z') },
    ] });
    const res = await request(app).get('/api/sessions/s1/chat');
    expect(res.status).toBe(200);
    expect(res.body[0].content).toBe('hallo');
  });

  it('DELETE /api/chat/:messageId → 204 wenn der Autor seine eigene Nachricht löscht + Broadcast chat.deleted', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ user_id: 'dev-user', session_id: 's1' }] }) // Nachricht-Lookup
      .mockResolvedValueOnce({ rows: [] }); // DELETE
    const res = await request(app).delete('/api/chat/msg-1');
    expect(res.status).toBe(204);
    expect(redis.publish as jest.Mock).toHaveBeenCalledWith(
      'session:s1:events',
      expect.stringContaining('chat.deleted'),
    );
  });

  it('DELETE /api/chat/:messageId → 204 wenn der Owner eine fremde Nachricht löscht (Dev = owner)', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ user_id: 'jemand-anders', session_id: 's1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).delete('/api/chat/msg-2');
    expect(res.status).toBe(204);
  });

  it('DELETE /api/chat/:messageId → 404 wenn die Nachricht nicht existiert', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const res = await request(app).delete('/api/chat/nicht-da');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/chat/:messageId → 403 wenn weder Autor noch Owner (echte Rollenprüfung)', async () => {
    process.env.DEV_ENFORCE_ROLES = 'true'; // Dev-owner-Kurzschluss aus → echte Rolle zählt
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ user_id: 'jemand-anders', session_id: 's1' }] }) // Nachricht
      .mockResolvedValueOnce({ rows: [] }); // getSessionRole → keine Rolle → nicht owner
    const res = await request(app).delete('/api/chat/msg-3');
    expect(res.status).toBe(403);
  });
});
