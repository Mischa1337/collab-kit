// H-Erweiterung — Zwei-Eimer-History: benannte Stände, Eimer-Filter, Voll-Verhalten (409),
// gezieltes Löschen/Umbenennen mit Rechte- und Auto-Slot-Schutz. Service gemockt, Dev-Modus (owner).
import request from 'supertest';

jest.mock('../config/db', () => ({ db: { query: jest.fn(), connect: jest.fn() }, connectDB: jest.fn() }));
jest.mock('../config/redis', () => ({
  redis: { publish: jest.fn().mockResolvedValue(1), set: jest.fn(), del: jest.fn(), getBuffer: jest.fn().mockResolvedValue(null) },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: { subscribe: jest.fn(), on: jest.fn(), unsubscribe: jest.fn() },
}));

jest.mock('../services/history/history.service', () => ({
  createVersion:        jest.fn().mockResolvedValue({ id: 'v1', scope: 'session', kind: 'manual' }),
  getHistory:           jest.fn().mockResolvedValue([]),
  getVersion:           jest.fn(),
  listByScope:          jest.fn().mockResolvedValue([]),
  countManual:          jest.fn().mockResolvedValue(0),
  getVersionById:       jest.fn(),
  deleteVersionById:    jest.fn().mockResolvedValue(true),
  renameVersion:        jest.fn().mockResolvedValue({ id: 'v1', name: 'neu' }),
  updateVersion:        jest.fn().mockResolvedValue({ id: 'v1', version_number: 3, session_id: '11111111-1111-1111-1111-111111111111', scope: 'session', content: 'neu', model_json: null }),
  upsertAutoVersion:    jest.fn().mockResolvedValue(undefined),
  SESSION_MANUAL_LIMIT: 10,
  PERSONAL_MANUAL_LIMIT: 5,
}));

import { app } from '../app';
import { redis } from '../config/redis';
import {
  createVersion, listByScope, countManual, getVersionById, deleteVersionById, getVersion, updateVersion,
} from '../services/history/history.service';

const SID = '11111111-1111-1111-1111-111111111111';
const VID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => jest.clearAllMocks());

describe('History — Eimer & benannte Stände', () => {
  it('POST persönlich → createVersion mit scope=personal + countManual auf eigenen Autor', async () => {
    const res = await request(app).post(`/api/sessions/${SID}/history`)
      .send({ content: 'SELECT 1', name: 'mein Zwischenstand', scope: 'personal' });
    expect(res.status).toBe(201);
    expect(countManual).toHaveBeenCalledWith(SID, 'personal', 'dev-user');
    expect(createVersion).toHaveBeenCalledWith(SID, 'SELECT 1', 'dev-user', { name: 'mein Zwischenstand', scope: 'personal', kind: 'manual' });
  });

  it('POST mit model_json im Body → createVersion bekommt das Modell aus dem Body (M11-Entwurf)', async () => {
    const model = { nodes: [{ id: 't1' }], edges: [] };
    const res = await request(app).post(`/api/sessions/${SID}/history`)
      .send({ content: 'SELECT 1', name: 'mein Entwurf', scope: 'personal', model_json: model });
    expect(res.status).toBe(201);
    expect(createVersion).toHaveBeenCalledWith(SID, 'SELECT 1', 'dev-user', { name: 'mein Entwurf', scope: 'personal', kind: 'manual', modelJson: model });
  });

  it('POST mit kaputtem model_json → 400', async () => {
    const res = await request(app).post(`/api/sessions/${SID}/history`)
      .send({ content: 'SELECT 1', name: 'x', scope: 'personal', model_json: { nodes: 'nope' } });
    expect(res.status).toBe(400);
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('POST persönlich bei vollem Eimer (5) → 409', async () => {
    (countManual as jest.Mock).mockResolvedValueOnce(5);
    const res = await request(app).post(`/api/sessions/${SID}/history`)
      .send({ content: 'SELECT 1', name: 'noch einer', scope: 'personal' });
    expect(res.status).toBe(409);
    expect(res.body.bucket).toBe('personal');
    expect(res.body.limit).toBe(5);
  });

  it('GET ?scope=personal → nur eigene Stände', async () => {
    await request(app).get(`/api/sessions/${SID}/history?scope=personal`);
    expect(listByScope).toHaveBeenCalledWith(SID, 'personal', 'dev-user');
  });

  it('GET ?scope=session → geteilte Stände (ohne Autor-Filter)', async () => {
    await request(app).get(`/api/sessions/${SID}/history?scope=session`);
    expect(listByScope).toHaveBeenCalledWith(SID, 'session');
  });

  it('DELETE eines Auto-Slots → 403 (nicht manuell verwaltbar)', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ author_id: 'dev-user', scope: 'personal', kind: 'auto', session_id: SID });
    const res = await request(app).delete(`/api/history/${VID}`);
    expect(res.status).toBe(403);
    expect(deleteVersionById).not.toHaveBeenCalled();
  });

  it('DELETE eines fremden persönlichen Stands → 403', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ author_id: 'jemand-anders', scope: 'personal', kind: 'manual', session_id: SID });
    const res = await request(app).delete(`/api/history/${VID}`);
    expect(res.status).toBe(403);
  });

  it('DELETE eines eigenen persönlichen Stands → 204', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ author_id: 'dev-user', scope: 'personal', kind: 'manual', session_id: SID });
    const res = await request(app).delete(`/api/history/${VID}`);
    expect(res.status).toBe(204);
    expect(deleteVersionById).toHaveBeenCalledWith(VID);
  });

  it('DELETE eines geteilten Stands als owner → 204', async () => {
    // Dev-Modus: checkSessionOwner → owner=true, daher auch ohne Autorschaft erlaubt.
    (getVersionById as jest.Mock).mockResolvedValueOnce({ author_id: 'jemand-anders', scope: 'session', kind: 'manual', session_id: SID });
    const res = await request(app).delete(`/api/history/${VID}`);
    expect(res.status).toBe(204);
  });

  it('DELETE auf unbekannten Stand → 404', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce(undefined);
    const res = await request(app).delete(`/api/history/${VID}`);
    expect(res.status).toBe(404);
  });

  it('PATCH Umbenennen eines Auto-Slots → 403', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ author_id: 'dev-user', scope: 'personal', kind: 'auto', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ name: 'neu' });
    expect(res.status).toBe(403);
  });

  it('PATCH Umbenennen eines eigenen Stands → 200', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ author_id: 'dev-user', scope: 'personal', kind: 'manual', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ name: 'neu' });
    expect(res.status).toBe(200);
  });

  it('PATCH content eines eigenen persönlichen Stands → 200, id/version_number bleiben (kein Delete+Insert)', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ id: VID, author_id: 'dev-user', scope: 'personal', kind: 'manual', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: 'SELECT 2' });
    expect(res.status).toBe(200);
    expect(deleteVersionById).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
    expect(updateVersion).toHaveBeenCalledWith(VID, { name: undefined, content: 'SELECT 2', modelJson: undefined, hasModelJson: false });
  });

  it('PATCH content eines geteilten Stands als owner (nicht Autor) → 200', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ id: VID, author_id: 'jemand-anders', scope: 'session', kind: 'manual', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: 'SELECT 2' });
    expect(res.status).toBe(200);
  });

  it('PATCH content eines geteilten Stands → broadcastet history.updated', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ id: VID, author_id: 'dev-user', scope: 'session', kind: 'manual', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: 'SELECT 2' });
    expect(res.status).toBe(200);
    expect(redis.publish as jest.Mock).toHaveBeenCalledWith(
      `session:${SID}:events`, expect.stringContaining('history.updated'),
    );
  });

  it('PATCH content eines fremden persönlichen Stands → 403, kein Update aufgerufen', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ id: VID, author_id: 'jemand-anders', scope: 'personal', kind: 'manual', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: 'SELECT 2' });
    expect(res.status).toBe(403);
    expect(updateVersion).not.toHaveBeenCalled();
  });

  it('PATCH content eines Auto-Slots → 403 (nicht manuell verwaltbar)', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ id: VID, author_id: 'dev-user', scope: 'personal', kind: 'auto', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: 'SELECT 2' });
    expect(res.status).toBe(403);
    expect(updateVersion).not.toHaveBeenCalled();
  });

  it('PATCH content auf unbekannten Stand → 404, kein Update aufgerufen', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce(undefined);
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: 'SELECT 2' });
    expect(res.status).toBe(404);
    expect(updateVersion).not.toHaveBeenCalled();
  });

  it('PATCH mit ungültigem model_json → 400, kein Update aufgerufen', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ id: VID, author_id: 'dev-user', scope: 'personal', kind: 'manual', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: 'SELECT 2', model_json: { nodes: 'nope' } });
    expect(res.status).toBe(400);
    expect(updateVersion).not.toHaveBeenCalled();
  });

  it('PATCH mit leerem content-String → 400, kein Update aufgerufen', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ id: VID, author_id: 'dev-user', scope: 'personal', kind: 'manual', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: '   ' });
    expect(res.status).toBe(400);
    expect(updateVersion).not.toHaveBeenCalled();
  });

  it('PATCH content mit model_json:null → hasModelJson true, modelJson null (Stand wird zur Textversion)', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ id: VID, author_id: 'dev-user', scope: 'personal', kind: 'manual', session_id: SID });
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: 'SELECT 2', model_json: null });
    expect(res.status).toBe(200);
    expect(updateVersion).toHaveBeenCalledWith(VID, { name: undefined, content: 'SELECT 2', modelJson: null, hasModelJson: true });
  });

  it('PATCH content wenn updateVersion undefined liefert (Stand zwischenzeitlich gelöscht) → 404', async () => {
    (getVersionById as jest.Mock).mockResolvedValueOnce({ id: VID, author_id: 'dev-user', scope: 'personal', kind: 'manual', session_id: SID });
    (updateVersion as jest.Mock).mockResolvedValueOnce(undefined);
    const res = await request(app).patch(`/api/history/${VID}`).send({ content: 'SELECT 2' });
    expect(res.status).toBe(404);
  });

  it('POST …/history/:version/restore (owner) → 200 + broadcastet history.restored', async () => {
    (getVersion as jest.Mock).mockResolvedValueOnce({ version_number: 3, content: 'SELECT 1', model_json: null });
    const res = await request(app).post(`/api/sessions/${SID}/history/3/restore`);
    expect(res.status).toBe(200);
    expect(res.body.version_number).toBe(3);
    expect(redis.publish as jest.Mock).toHaveBeenCalledWith(
      `session:${SID}:events`, expect.stringContaining('history.restored'),
    );
  });

  it('POST …/restore auf unbekannte Version → 404', async () => {
    (getVersion as jest.Mock).mockResolvedValueOnce(undefined);
    const res = await request(app).post(`/api/sessions/${SID}/history/99/restore`);
    expect(res.status).toBe(404);
  });
});
