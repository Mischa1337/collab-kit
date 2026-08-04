// H7 — Aufgaben-Tests. DB/Redis gemockt; broadcastToSession → redis.publish.
// Rollen-Durchsetzung (owner/member) liegt in der geteilten Middleware/Helfer
// (in authorization.test geprüft); hier: CRUD, Validierung, Broadcast im Dev-Modus.
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

const SID = '11111111-1111-1111-1111-111111111111';
const TID = '22222222-2222-2222-2222-222222222222';
const FAKE_TASK = {
  id: TID, session_id: SID, title: 'Aufgabe', description: null,
  assignee_user_id: null, status: 'open', created_by: 'dev-user',
  created_at: 't', updated_at: 't',
};

beforeEach(() => jest.clearAllMocks());

describe('H7 — Session-Aufgaben', () => {
  it('POST /sessions/:id/tasks → 201 und broadcastet task.created', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE_TASK] }); // INSERT
    const res = await request(app).post(`/api/sessions/${SID}/tasks`).send({ title: 'Aufgabe' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(TID);
    expect(res.body.status).toBe('open');
    expect(redis.publish as jest.Mock).toHaveBeenCalledWith(
      `session:${SID}:events`, expect.stringContaining('task.created'),
    );
  });

  it('POST ohne title → 400', async () => {
    const res = await request(app).post(`/api/sessions/${SID}/tasks`).send({});
    expect(res.status).toBe(400);
  });

  it('GET /sessions/:id/tasks → 200 mit Liste', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE_TASK] });
    const res = await request(app).get(`/api/sessions/${SID}/tasks`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('PATCH /tasks/:taskId → 200 und broadcastet task.updated', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [FAKE_TASK] })                       // getTask
      .mockResolvedValueOnce({ rows: [{ ...FAKE_TASK, status: 'done' }] }); // updateTask
    const res = await request(app).patch(`/api/tasks/${TID}`).send({ status: 'done' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(redis.publish as jest.Mock).toHaveBeenCalledWith(
      `session:${SID}:events`, expect.stringContaining('task.updated'),
    );
  });

  it('PATCH mit ungültigem status → 400', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE_TASK] }); // getTask
    const res = await request(app).patch(`/api/tasks/${TID}`).send({ status: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('PATCH auf unbekannte Aufgabe → 404', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] }); // getTask leer
    const res = await request(app).patch(`/api/tasks/${TID}`).send({ status: 'done' });
    expect(res.status).toBe(404);
  });

  it('DELETE /tasks/:taskId durch Ersteller → 204 und broadcastet task.deleted', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [FAKE_TASK] }) // getTask (created_by = dev-user)
      .mockResolvedValueOnce({ rowCount: 1 });      // deleteTask
    const res = await request(app).delete(`/api/tasks/${TID}`);
    expect(res.status).toBe(204);
    expect(redis.publish as jest.Mock).toHaveBeenCalledWith(
      `session:${SID}:events`, expect.stringContaining('task.deleted'),
    );
  });
});

// Reihenfolge der db.query-Mocks im PATCH: getTask → getSessionRole (nur im Enforce-Modus) → updateTask.
describe('H7 — PATCH-Rechte: Assignee darf NUR den Status ändern (Enforce-Modus)', () => {
  beforeEach(() => { process.env.DEV_ENFORCE_ROLES = 'true'; }); // Dev-owner-Kurzschluss aus → echte Rolle zählt
  afterEach(() => { delete process.env.DEV_ENFORCE_ROLES; });

  const ASSIGNED = { ...FAKE_TASK, assignee_user_id: 'dev-user' }; // dev-user = der aufrufende Nutzer

  it('Assignee (commentator) setzt Status → 200', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [ASSIGNED] })                          // getTask
      .mockResolvedValueOnce({ rows: [{ role: 'commentator' }] })           // getSessionRole → kein Editor
      .mockResolvedValueOnce({ rows: [{ ...ASSIGNED, status: 'done' }] });  // updateTask
    const res = await request(app).patch(`/api/tasks/${TID}`).send({ status: 'done' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
  });

  it('Assignee ändert Titel → 403 (nur Status erlaubt)', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [ASSIGNED] })                 // getTask
      .mockResolvedValueOnce({ rows: [{ role: 'commentator' }] }); // getSessionRole
    const res = await request(app).patch(`/api/tasks/${TID}`).send({ title: 'gekapert' });
    expect(res.status).toBe(403);
  });

  it('Nicht-Assignee ohne Editier-Recht setzt Status → 403', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ ...FAKE_TASK, assignee_user_id: 'jemand-anders' }] }) // getTask
      .mockResolvedValueOnce({ rows: [{ role: 'commentator' }] });                            // getSessionRole
    const res = await request(app).patch(`/api/tasks/${TID}`).send({ status: 'done' });
    expect(res.status).toBe(403);
  });

  it('member darf Meta (Titel) ändern → 200', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [FAKE_TASK] })                        // getTask
      .mockResolvedValueOnce({ rows: [{ role: 'member' }] })               // getSessionRole → Editor
      .mockResolvedValueOnce({ rows: [{ ...FAKE_TASK, title: 'neu' }] });  // updateTask
    const res = await request(app).patch(`/api/tasks/${TID}`).send({ title: 'neu' });
    expect(res.status).toBe(200);
  });

  it('member (nicht Assignee) darf den Status einer ZUGEWIESENEN Aufgabe NICHT ändern → 403', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ ...FAKE_TASK, assignee_user_id: 'jemand-anders' }] }) // getTask (zugewiesen)
      .mockResolvedValueOnce({ rows: [{ role: 'member' }] });                                  // getSessionRole → Editor
    const res = await request(app).patch(`/api/tasks/${TID}`).send({ status: 'done' });
    expect(res.status).toBe(403);
  });

  it('owner/member darf Status einer UNZUGEWIESENEN Aufgabe setzen → 200 (Fallback)', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [FAKE_TASK] })                         // getTask (assignee null)
      .mockResolvedValueOnce({ rows: [{ role: 'member' }] })                // getSessionRole → Editor
      .mockResolvedValueOnce({ rows: [{ ...FAKE_TASK, status: 'done' }] }); // updateTask
    const res = await request(app).patch(`/api/tasks/${TID}`).send({ status: 'done' });
    expect(res.status).toBe(200);
  });
});
