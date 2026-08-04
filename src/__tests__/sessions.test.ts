// M5 — Session Manager Tests (REST-API)
// Prüft POST /api/sessions und GET /api/sessions/:id.
// DB und Redis werden gemockt — kein laufender Docker nötig.
import request from 'supertest';
import { app } from '../app';
import { db } from '../config/db';
import { redis } from '../config/redis';

jest.mock('../config/db', () => {
  const mockQuery = jest.fn();
  return {
    db: {
      query: mockQuery,
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({ query: mockQuery, release: jest.fn() })
      ),
    },
  };
});

// redis-Methoden werden ersetzt, damit keine echte Redis-Verbindung nötig ist.
jest.mock('../config/redis', () => ({
  redis: {
    del: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
    scan: jest.fn().mockResolvedValue(['0', []]),
  },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: {
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    unsubscribe: jest.fn(),
  },
}));

// Wiederverwendbare Fake-Session — entspricht dem was die DB zurückgeben würde.
const FAKE_SESSION = {
  id: 'abc-123-uuid',
  name: 'test-session',
  created_by: 'dev-user',
  created_at: '2026-05-08T10:00:00.000Z',
};

describe('M5 — Session Manager (REST)', () => {

  describe('POST /api/sessions', () => {
    beforeEach(() => {
      (db.query as jest.Mock).mockReset();
    });

    // Hauptpfad: Session mit name erstellen → created_by kommt aus req.user (auth), nicht aus Body.
    it('erstellt eine Session und gibt 201 zurück', async () => {
      // Session-Erstellung läuft in einer Transaction: BEGIN + INSERT sessions + INSERT documents + COMMIT
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] })              // BEGIN
        .mockResolvedValueOnce({ rows: [FAKE_SESSION] })  // INSERT sessions
        .mockResolvedValueOnce({ rows: [] })              // INSERT documents
        .mockResolvedValueOnce({ rows: [] });             // COMMIT

      const res = await request(app)
        .post('/api/sessions')
        .send({ name: 'test-session' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('abc-123-uuid');
      expect(res.body.name).toBe('test-session');
      expect(res.body.created_by).toBe('dev-user');
      expect(res.body).toHaveProperty('created_at');
    });

    // Validierung: name ist Pflichtfeld — ohne es darf der Server nicht in die DB schreiben.
    it('gibt 400 zurück wenn name fehlt', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({});

      expect(res.status).toBe(400);
    });

    // Validierung: name muss ein String sein — kein Objekt, Array oder Zahl.
    it('gibt 400 zurück wenn name kein String ist', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ name: { hack: true } });

      expect(res.status).toBe(400);
    });

    // Validierung: name darf nicht nur aus Leerzeichen bestehen.
    it('gibt 400 zurück wenn name nur aus Leerzeichen besteht', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ name: '   ' });

      expect(res.status).toBe(400);
    });

    // Robustheit: wenn die DB-Verbindung nicht aufgebaut werden kann, mit 500 antworten.
    it('gibt 500 zurück bei Datenbankfehler', async () => {
      (db.connect as jest.Mock).mockRejectedValueOnce(new Error('DB nicht erreichbar'));

      const res = await request(app)
        .post('/api/sessions')
        .send({ name: 'test-session', created_by: 'dev-user' });

      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/sessions (Liste, H8)', () => {
    beforeEach(() => {
      (db.query as jest.Mock).mockReset();
      (redis.scan as jest.Mock).mockReset().mockResolvedValue(['0', []]);
    });

    it('liefert Mitglieds-Sessions inkl. aktiver Nutzer je Session', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [
        { id: 's1', name: 'A', created_at: 't', role: 'owner' },
        { id: 's2', name: 'B', created_at: 't', role: 'member' },
      ] });
      (redis.scan as jest.Mock)
        .mockResolvedValueOnce(['0', ['presence:s1:dev-user:c1']]) // s1: 1 aktiv
        .mockResolvedValueOnce(['0', []]);                          // s2: keiner

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].active_users).toEqual(['dev-user']);
      expect(res.body[1].active_users).toEqual([]);
    });

    it('?active=true filtert auf Sessions mit aktiven Nutzern', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [
        { id: 's1', name: 'A', created_at: 't', role: 'owner' },
        { id: 's2', name: 'B', created_at: 't', role: 'member' },
      ] });
      (redis.scan as jest.Mock)
        .mockResolvedValueOnce(['0', ['presence:s1:dev-user:c1']])
        .mockResolvedValueOnce(['0', []]);

      const res = await request(app).get('/api/sessions?active=true');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe('s1');
    });
  });

  describe('GET /api/sessions/:id', () => {
    // Normalfall: Session existiert, aber gerade ist niemand per WebSocket verbunden.
    it('gibt Session mit leerer Nutzerliste zurück', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE_SESSION] });
      // M22: keine presence-Keys → active_users: []
      (redis.scan as jest.Mock).mockResolvedValueOnce(['0', []]);

      const res = await request(app).get('/api/sessions/abc-123-uuid');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('abc-123-uuid');
      expect(res.body.active_users).toEqual([]);
    });

    // M5-Kernfunktion: active_users zeigt alle gerade verbundenen WebSocket-Clients aus Redis.
    it('gibt Session mit aktiven Nutzern zurück', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE_SESSION] });
      // M22: presence-Keys zweier Nutzer (Format presence:{sessionId}:{userId}:{connId}) → dedupliziert.
      (redis.scan as jest.Mock).mockResolvedValueOnce([
        '0',
        ['presence:abc-123-uuid:dev-user:c1', 'presence:abc-123-uuid:nutzer-2:c2'],
      ]);

      const res = await request(app).get('/api/sessions/abc-123-uuid');

      expect(res.status).toBe(200);
      expect(res.body.active_users).toEqual(['dev-user', 'nutzer-2']);
    });

    // Fehlerfall: unbekannte UUID → DB gibt leeres Ergebnis → Server antwortet mit 404.
    it('gibt 404 zurück wenn Session nicht existiert', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/sessions/nicht-existent');

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    beforeEach(() => {
      (db.query as jest.Mock).mockReset();
    });

    // Normalfall: Ersteller löscht eigene Session → 1 DB-Query, Redis bereinigt, 204.
    it('löscht die Session und gibt 204 zurück wenn der Ersteller die Anfrage stellt', async () => {
      // Atomare DELETE-Query gibt gelöschte Row zurück (Ersteller = anfragender User)
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'abc-123-uuid' }] });

      const res = await request(app).delete('/api/sessions/abc-123-uuid');

      expect(res.status).toBe(204);
      expect(redis.del).toHaveBeenCalled();
    });

    // Sicherheit: anderer User versucht eine fremde Session zu löschen → 403.
    it('gibt 403 zurück wenn der anfragende User nicht der Ersteller ist', async () => {
      // Atomare DELETE: 0 Rows (created_by stimmt nicht überein)
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] })              // DELETE liefert 0 Rows
        .mockResolvedValueOnce({ rows: [FAKE_SESSION] }); // SELECT zeigt: Session existiert

      const res = await request(app).delete('/api/sessions/abc-123-uuid');

      expect(res.status).toBe(403);
      expect(redis.del).not.toHaveBeenCalled();
    });

    // Fehlerfall: Session existiert nicht → 404.
    it('gibt 404 zurück wenn die Session nicht existiert', async () => {
      // Atomare DELETE: 0 Rows (nicht gefunden)
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] })  // DELETE liefert 0 Rows
        .mockResolvedValueOnce({ rows: [] }); // SELECT: Session existiert auch nicht

      const res = await request(app).delete('/api/sessions/nicht-existent');

      expect(res.status).toBe(404);
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

});
