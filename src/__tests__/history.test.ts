// M7 — Versionsverlauf Tests
// Zwei Ebenen: (1) HTTP-Routen mit gemocktem Service, (2) Service-Logik mit gemockter DB.
import request from 'supertest';
import { app } from '../app';

// History-Service mocken damit Route-Tests unabhängig von der Service-Implementierung sind.
jest.mock('../services/history/history.service', () => ({
  createVersion:     jest.fn(),
  getHistory:        jest.fn(),
  getVersion:        jest.fn(),
  listByScope:       jest.fn().mockResolvedValue([]),
  countManual:       jest.fn().mockResolvedValue(0),
  getVersionById:    jest.fn(),
  deleteVersionById: jest.fn().mockResolvedValue(true),
  renameVersion:     jest.fn(),
  SESSION_MANUAL_LIMIT: 10,
  PERSONAL_MANUAL_LIMIT: 5,
}));

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

jest.mock('../config/redis', () => ({
  redis: { publish: jest.fn().mockResolvedValue(1) },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: { on: jest.fn() },
}));

jest.mock('y-websocket/bin/utils', () => ({
  setupWSConnection: jest.fn(),
  setPersistence:    jest.fn(),
}));

import { createVersion, getHistory, countManual } from '../services/history/history.service';
import { db } from '../config/db';

const FAKE_VERSION = {
  id: 'version-uuid-1',
  session_id: 'session-123',
  version_number: 1,
  content: 'SELECT * FROM users',
  author_id: 'user-abc',
  created_at: new Date().toISOString(),
};

// ── Route-Tests ────────────────────────────────────────────────────────────────

describe('M7 — Versionsverlauf (Routen)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('POST /api/sessions/:id/history', () => {
    it('speichert eine neue Version und gibt 201 mit Versions-Metadaten zurück', async () => {
      (createVersion as jest.Mock).mockResolvedValueOnce(FAKE_VERSION);

      const res = await request(app)
        .post('/api/sessions/session-123/history')
        .send({ content: 'SELECT * FROM users', name: 'erster Entwurf' });

      expect(res.status).toBe(201);
      expect(res.body.version_number).toBe(1);
      expect(res.body.content).toBe('SELECT * FROM users');
    });

    it('verwendet req.user.id als author_id (aus authMiddleware)', async () => {
      (createVersion as jest.Mock).mockResolvedValueOnce({ ...FAKE_VERSION, author_id: 'dev-user' });

      await request(app)
        .post('/api/sessions/session-123/history')
        .send({ content: 'SELECT 1', name: 'mein Stand' });

      // Ohne AUTH_SERVICE_URL setzt authMiddleware req.user = { id: 'dev-user', ... }
      expect(createVersion).toHaveBeenCalledWith('session-123', 'SELECT 1', 'dev-user', { name: 'mein Stand', scope: 'session', kind: 'manual' });
    });

    it('gibt 400 zurück wenn name fehlt (benannter Stand ist Pflicht)', async () => {
      const res = await request(app)
        .post('/api/sessions/session-123/history')
        .send({ content: 'SELECT 1' });

      expect(res.status).toBe(400);
      expect(createVersion).not.toHaveBeenCalled();
    });

    it('gibt 409 zurück wenn der Eimer voll ist', async () => {
      (countManual as jest.Mock).mockResolvedValueOnce(10); // session-Limit erreicht

      const res = await request(app)
        .post('/api/sessions/session-123/history')
        .send({ content: 'SELECT 1', name: 'noch einer' });

      expect(res.status).toBe(409);
      expect(res.body.bucket).toBe('session');
      expect(createVersion).not.toHaveBeenCalled();
    });

    it('gibt 400 zurück wenn content fehlt oder leer ist', async () => {
      const res = await request(app)
        .post('/api/sessions/session-123/history')
        .send({});

      expect(res.status).toBe(400);
      expect(createVersion).not.toHaveBeenCalled();
    });

    it('gibt 400 zurück wenn content nur aus Leerzeichen besteht', async () => {
      const res = await request(app)
        .post('/api/sessions/session-123/history')
        .send({ content: '   ' });

      expect(res.status).toBe(400);
      expect(createVersion).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/sessions/:id/history', () => {
    it('gibt die vollständige Versionsliste mit Autor und Zeitstempel zurück', async () => {
      (getHistory as jest.Mock).mockResolvedValueOnce([
        FAKE_VERSION,
        { ...FAKE_VERSION, version_number: 2, content: 'SELECT id FROM users' },
      ]);

      const res = await request(app).get('/api/sessions/session-123/history');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toHaveProperty('author_id');
      expect(res.body[0]).toHaveProperty('created_at');
      expect(res.body[0]).toHaveProperty('version_number');
    });

    it('gibt leeres Array zurück wenn noch keine Versionen gespeichert wurden', async () => {
      (getHistory as jest.Mock).mockResolvedValueOnce([]);

      const res = await request(app).get('/api/sessions/session-123/history');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('übergibt limit und offset korrekt an den Service', async () => {
      (getHistory as jest.Mock).mockResolvedValueOnce([FAKE_VERSION]);

      await request(app).get('/api/sessions/session-123/history?limit=10&offset=20');

      expect(getHistory).toHaveBeenCalledWith('session-123', 10, 20);
    });

    it('gibt 400 zurück wenn limit kleiner als 1 ist', async () => {
      const res = await request(app).get('/api/sessions/session-123/history?limit=0');
      expect(res.status).toBe(400);
    });

    it('gibt 400 zurück wenn limit keine Zahl ist', async () => {
      const res = await request(app).get('/api/sessions/session-123/history?limit=abc');
      expect(res.status).toBe(400);
    });

    it('gibt 400 zurück wenn offset negativ ist', async () => {
      const res = await request(app).get('/api/sessions/session-123/history?offset=-1');
      expect(res.status).toBe(400);
    });

    it('gibt 400 zurück wenn limit größer als 200 ist', async () => {
      const res = await request(app).get('/api/sessions/session-123/history?limit=201');
      expect(res.status).toBe(400);
    });
  });

});

// ── Service-Logik Tests ────────────────────────────────────────────────────────
// Testen die DB-Logik des History-Service direkt ohne HTTP-Layer.
// db ist bereits per jest.mock('../config/db', ...) oben gemockt.

describe('M7 — History Service (Logik)', () => {
  let dbQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    dbQuery = db.query as unknown as jest.Mock;
    // clearAllMocks löscht nicht die once-Queue — explizit zurücksetzen,
    // damit Leftover-Mocks aus vorigen Tests nicht in den nächsten überlaufen.
    dbQuery.mockReset();
  });

  it('vergibt innerhalb einer Session aufsteigende Versionsnummern (1, 2, 3 ...)', async () => {
    const makeRow = (vn: number, content: string) => ({
      id: `id-${vn}`, session_id: 's1', version_number: vn,
      content, author_id: 'user', created_at: new Date(),
    });

    // createVersion: je 4 Calls pro Aufruf (BEGIN + pg_advisory_xact_lock + INSERT + COMMIT)
    dbQuery
      .mockResolvedValueOnce({ rows: [] })                             // BEGIN (v1)
      .mockResolvedValueOnce({ rows: [] })                             // pg_advisory_xact_lock (v1)
      .mockResolvedValueOnce({ rows: [makeRow(1, 'v1')] })             // INSERT (v1)
      .mockResolvedValueOnce({ rows: [] })                             // COMMIT (v1)
      .mockResolvedValueOnce({ rows: [] })                             // BEGIN (v2)
      .mockResolvedValueOnce({ rows: [] })                             // pg_advisory_xact_lock (v2)
      .mockResolvedValueOnce({ rows: [makeRow(2, 'v2')] })             // INSERT (v2)
      .mockResolvedValueOnce({ rows: [] })                             // COMMIT (v2)
      .mockResolvedValueOnce({ rows: [] })                             // BEGIN (v3)
      .mockResolvedValueOnce({ rows: [] })                             // pg_advisory_xact_lock (v3)
      .mockResolvedValueOnce({ rows: [makeRow(3, 'v3')] })             // INSERT (v3)
      .mockResolvedValueOnce({ rows: [] })                             // COMMIT (v3)
      // getHistory
      .mockResolvedValueOnce({ rows: [makeRow(1, 'v1'), makeRow(2, 'v2'), makeRow(3, 'v3')] });

    const { createVersion: svcCreate, getHistory: svcHistory } =
      jest.requireActual('../services/history/history.service');

    await svcCreate('s1', 'v1', 'user');
    await svcCreate('s1', 'v2', 'user');
    await svcCreate('s1', 'v3', 'user');
    const history = await svcHistory('s1');

    expect(history.map((v: { version_number: number }) => v.version_number)).toEqual([1, 2, 3]);
  });

  it('gespeicherte Version enthält author_id und created_at als Date-Objekt', async () => {
    const createdAt = new Date();
    dbQuery
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [] })  // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [{ id: 'id-1', session_id: 'session-meta', version_number: 1, content: 'inhalt', author_id: 'author-xyz', created_at: createdAt }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const { createVersion: svcCreate } = jest.requireActual('../services/history/history.service');
    const v = await svcCreate('session-meta', 'inhalt', 'author-xyz');

    expect(v.author_id).toBe('author-xyz');
    expect(v.created_at).toBeInstanceOf(Date);
  });

  it('createVersion speichert das Modell als model_json (M11)', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock
      .mockResolvedValueOnce({ rows: [{ id: 'v1', session_id: 's', version_number: 1, content: 'x', author_id: 'u', name: null, scope: 'session', kind: 'manual', model_json: { nodes: [{ id: 't1' }], edges: [] }, created_at: new Date() }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const { createVersion: svcCreate } = jest.requireActual('../services/history/history.service');
    const v = await svcCreate('s', 'SELECT 1', 'u', { name: 'x', scope: 'session', kind: 'manual', modelJson: { nodes: [{ id: 't1' }], edges: [] } });

    const insertCall = (dbQuery.mock.calls as unknown[][]).find(c => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO history'))!;
    expect(insertCall[0]).toContain('model_json');
    const params = insertCall[1] as unknown[];
    expect(String(params[params.length - 1])).toContain('"t1"'); // letzter Param = stringified Modell
    expect(v.model_json).toEqual({ nodes: [{ id: 't1' }], edges: [] });
  });

  it('getVersion gibt undefined zurück wenn die Version nicht existiert', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const { getVersion: svcVersion } = jest.requireActual('../services/history/history.service');
    expect(await svcVersion('session-leer', 1)).toBeUndefined();
  });

  it('getVersion gibt die richtige Version zurück wenn mehrere existieren', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{
      id: 'id-2', session_id: 'session-multi', version_number: 2,
      content: 'zweiter Stand', author_id: 'user', created_at: new Date(),
    }] });

    const { getVersion: svcVersion } = jest.requireActual('../services/history/history.service');
    const v2 = await svcVersion('session-multi', 2);

    expect(v2?.content).toBe('zweiter Stand');
    expect(v2?.version_number).toBe(2);
  });
});
