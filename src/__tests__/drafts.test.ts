// Privates Arbeitsmodell (Entwurf) — CRUD + Veröffentlichen. DB/Redis/y-websocket gemockt, Dev-Modus (owner).
import request from 'supertest';
import { redis } from '../config/redis';
import { db } from '../config/db';

const SID = '11111111-1111-1111-1111-111111111111';

// Transaktionsfähiger Fake-Client (BEGIN/…/COMMIT/ROLLBACK + release) — wird vom neuen
// buildPreSnapshot()/upsertAutoVersion()-Pfad beim Veröffentlichen gebraucht (Auto-Sicherung
// des Live-Stands vor dem Publish).
jest.mock('../config/db', () => ({
  db: {
    query: jest.fn(),
    connect: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
  },
  connectDB: jest.fn(),
}));
jest.mock('../config/redis', () => ({
  redis: { publish: jest.fn().mockResolvedValue(1), set: jest.fn(), del: jest.fn(), getBuffer: jest.fn().mockResolvedValue(null) },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: { subscribe: jest.fn(), on: jest.fn(), unsubscribe: jest.fn() },
}));
// publish() schreibt jetzt direkt ins live Y.Doc — braucht einen echten Y.Doc-Eintrag,
// damit yjsDocs.get(sessionId) nicht undefined liefert (sonst 409 "Sitzung nicht aktiv").
jest.mock('y-websocket/bin/utils', () => ({
  setupWSConnection: jest.fn(),
  setPersistence: jest.fn(),
  docs: new Map([['11111111-1111-1111-1111-111111111111', new (jest.requireActual('yjs').Doc)()]]),
}));

import { app } from '../app';
import { docs as yjsDocs } from 'y-websocket/bin/utils';

const DRAFT = { session_id: SID, user_id: 'dev-user', content: 'SELECT 1', model_json: { nodes: [{ id: 't1' }], edges: [] }, updated_at: 't' };

beforeEach(() => {
  jest.clearAllMocks();
  // Frischer, leerer Y.Doc pro Test — sonst würden Publish-Tests sich gegenseitig über den
  // gemeinsamen (modulweiten) Fake-Y.Doc-Eintrag beeinflussen (Reihenfolge-Abhängigkeit).
  yjsDocs.set(SID, new (jest.requireActual('yjs').Doc)());
});

describe('Privates Arbeitsmodell — Entwurf', () => {
  it('GET /sessions/:id/draft → eigener Entwurf', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [DRAFT] });
    const res = await request(app).get(`/api/sessions/${SID}/draft`);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('SELECT 1');
  });

  it('GET ohne Entwurf → leeres Objekt', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/sessions/${SID}/draft`);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('');
    expect(res.body.model_json).toBeNull();
  });

  it('PUT /sessions/:id/draft → upsert (200)', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [DRAFT] });
    const res = await request(app).put(`/api/sessions/${SID}/draft`).send({ content: 'SELECT 1', model_json: { nodes: [{ id: 't1' }], edges: [] } });
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(SID);
  });

  it('PUT mit nicht-String content → 400', async () => {
    const res = await request(app).put(`/api/sessions/${SID}/draft`).send({ content: 123 });
    expect(res.status).toBe(400);
  });

  it('DELETE /sessions/:id/draft → 204', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app).delete(`/api/sessions/${SID}/draft`);
    expect(res.status).toBe(204);
  });

  it('POST publish (merge) → 200 + broadcastet draft.published', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [DRAFT] }); // getDraft
    const res = await request(app).post(`/api/sessions/${SID}/draft/publish`).send({ mode: 'merge' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('merge');
    // model_json ist bewusst nicht Teil der Response — das Backend schreibt den Entwurf direkt
    // ins geteilte Y.Doc, der normale Yjs-Sync-Pfad bringt den Stand an alle Clients zurück
    // (siehe SidebarSync.vue publishDraft()).
    expect(redis.publish as jest.Mock).toHaveBeenCalledWith(
      `session:${SID}:events`, expect.stringContaining('draft.published'),
    );
  });

  it('POST publish ohne Entwurf → 400', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] }); // getDraft leer
    const res = await request(app).post(`/api/sessions/${SID}/draft/publish`).send({ mode: 'merge' });
    expect(res.status).toBe(400);
  });

  it('POST publish (replace) als owner (Dev-Modus) → 200', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [DRAFT] }); // getDraft
    const res = await request(app).post(`/api/sessions/${SID}/draft/publish`).send({ mode: 'replace' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('replace');
  });
});
