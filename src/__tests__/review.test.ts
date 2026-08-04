// Peer Review (Umbau) — Multi-Reviewer, Adressierung (audience/assignees), version_id Pflicht.
// review.service gemockt → Routen-Logik isoliert; db nur für die Versions-Existenzprüfung.
import request from 'supertest';

jest.mock('../config/db', () => ({ db: { query: jest.fn() } }));
jest.mock('../utils/broadcast', () => ({ broadcastToSession: jest.fn() }));
jest.mock('../services/notifications/notification.service', () => ({
  notifyReviewCreated: jest.fn(),
  notifyReviewFeedback: jest.fn(),
}));
jest.mock('../services/reviews/review.service', () => ({
  createReview:  jest.fn(),
  getReview:     jest.fn(),
  getReviewMeta: jest.fn(),
  isAssignee:    jest.fn(),
  addFeedback:   jest.fn(),
  closeReview:   jest.fn(),
  deleteReview:  jest.fn(),
}));

import { app } from '../app';
import { db } from '../config/db';
import { broadcastToSession } from '../utils/broadcast';
import { createReview, getReview, getReviewMeta, isAssignee, addFeedback, closeReview, deleteReview } from '../services/reviews/review.service';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VID = '11111111-2222-3333-4444-555555555555';
const RID = '99999999-8888-7777-6666-555555555555';

const AGG = {
  id: RID, session_id: SID, requester_id: 'dev-user', status: 'offen',
  version_id: VID, audience: 'all', created_at: 't',
  version: { version_number: 3, content: 'SELECT 1', model_json: null },
  assignees: [], feedback: [], comments: [], open_comments: 0, resolved_comments: 0,
};

beforeEach(() => {
  // mockReset (nicht nur clear) — leert auch die mockResolvedValueOnce-Queues, damit
  // nicht-konsumierte Werte (z. B. bei 400-Pfaden vor dem Service-Aufruf) nicht überlaufen.
  [createReview, getReview, getReviewMeta, isAssignee, addFeedback, closeReview, deleteReview, db.query, broadcastToSession]
    .forEach((f) => (f as jest.Mock).mockReset());
});

describe('POST /api/reviews — Anfrage anlegen', () => {
  it('201 mit eingebetteter Version + Broadcast (audience=all)', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ session_id: SID }] }); // Versions-Check
    (createReview as jest.Mock).mockResolvedValueOnce({ id: RID });
    (getReview as jest.Mock).mockResolvedValueOnce(AGG);

    const res = await request(app).post('/api/reviews').send({ sessionId: SID, versionId: VID });
    expect(res.status).toBe(201);
    expect(res.body.version.content).toBe('SELECT 1');
    expect(broadcastToSession).toHaveBeenCalledWith(SID, expect.objectContaining({ type: 'review.created' }));
  });

  it('400 wenn versionId fehlt (Pflicht)', async () => {
    const res = await request(app).post('/api/reviews').send({ sessionId: SID });
    expect(res.status).toBe(400);
    expect(createReview).not.toHaveBeenCalled();
  });

  it('400 wenn audience=selected ohne assignees', async () => {
    const res = await request(app).post('/api/reviews').send({ sessionId: SID, versionId: VID, audience: 'selected', assignees: [] });
    expect(res.status).toBe(400);
  });

  it('400 wenn die Version zu einer anderen Session gehört', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ session_id: 'andere' }] });
    const res = await request(app).post('/api/reviews').send({ sessionId: SID, versionId: VID });
    expect(res.status).toBe(400);
    expect(createReview).not.toHaveBeenCalled();
  });

  it('gezielt: createReview bekommt audience=selected + assignees', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ session_id: SID }] });
    (createReview as jest.Mock).mockResolvedValueOnce({ id: RID });
    (getReview as jest.Mock).mockResolvedValueOnce(AGG);

    await request(app).post('/api/reviews').send({ sessionId: SID, versionId: VID, audience: 'selected', assignees: ['bob', 'carol'] });
    expect(createReview).toHaveBeenCalledWith(SID, 'dev-user', VID, 'selected', ['bob', 'carol']);
  });
});

describe('POST /api/reviews/:id/feedback — mein Feedback', () => {
  it('200 + Broadcast feedback_added', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce({ id: RID, session_id: SID, requester_id: 'someone', audience: 'all' });
    (addFeedback as jest.Mock).mockResolvedValueOnce({ ...AGG, feedback: [{ author_id: 'dev-user', feedback: 'gut', verdict: 'approved' }] });

    const res = await request(app).post(`/api/reviews/${RID}/feedback`).send({ feedback: 'gut', verdict: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.feedback).toHaveLength(1);
    expect(broadcastToSession).toHaveBeenCalledWith(SID, expect.objectContaining({ type: 'review.feedback_added' }));
  });

  it('400 bei leerem Feedback', async () => {
    const res = await request(app).post(`/api/reviews/${RID}/feedback`).send({ feedback: '   ' });
    expect(res.status).toBe(400);
  });

  it('400 bei ungültigem verdict', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce({ id: RID, session_id: SID, requester_id: 'x', audience: 'all' });
    const res = await request(app).post(`/api/reviews/${RID}/feedback`).send({ feedback: 'ok', verdict: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('404 wenn Review nicht existiert', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).post(`/api/reviews/${RID}/feedback`).send({ feedback: 'ok' });
    expect(res.status).toBe(404);
  });

  it('403 wenn audience=selected und ich kein Assignee bin', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce({ id: RID, session_id: SID, requester_id: 'x', audience: 'selected' });
    (isAssignee as jest.Mock).mockResolvedValueOnce(false);
    const res = await request(app).post(`/api/reviews/${RID}/feedback`).send({ feedback: 'ok' });
    expect(res.status).toBe(403);
    expect(addFeedback).not.toHaveBeenCalled();
  });
});

describe('POST /api/reviews/:id/close', () => {
  it('200 als Reviewer (owner/member, NICHT der Anfrager) + Broadcast review.closed', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce({ id: RID, session_id: SID, requester_id: 'jemand-anders', audience: 'all' });
    (closeReview as jest.Mock).mockResolvedValueOnce({ ...AGG, status: 'abgeschlossen' });
    const res = await request(app).post(`/api/reviews/${RID}/close`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('abgeschlossen');
    expect(broadcastToSession).toHaveBeenCalledWith(SID, expect.objectContaining({ type: 'review.closed' }));
  });

  it('403: der Anfrager darf sein EIGENES Review NICHT abschließen (auch als owner/member)', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce({ id: RID, session_id: SID, requester_id: 'dev-user', audience: 'all' });
    const res = await request(app).post(`/api/reviews/${RID}/close`).send({});
    expect(res.status).toBe(403);
    expect(closeReview).not.toHaveBeenCalled();
  });
});

describe('GET /api/reviews/:id', () => {
  it('200 mit Aggregat (Version + Feedback-Liste)', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce({ id: RID, session_id: SID });
    (getReview as jest.Mock).mockResolvedValueOnce(AGG);
    const res = await request(app).get(`/api/reviews/${RID}`);
    expect(res.status).toBe(200);
    expect(res.body.version.version_number).toBe(3);
    expect(Array.isArray(res.body.feedback)).toBe(true);
  });

  it('404 wenn Review nicht existiert', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).get(`/api/reviews/${RID}`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/reviews/:id — Anfrage löschen (versehentlich)', () => {
  const meta = (over: Record<string, unknown> = {}) =>
    ({ id: RID, session_id: SID, requester_id: 'dev-user', status: 'offen', ...over });

  it('404 wenn Review nicht existiert', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).delete(`/api/reviews/${RID}`);
    expect(res.status).toBe(404);
    expect(deleteReview).not.toHaveBeenCalled();
  });

  it('Dev-Modus (jeder owner) → 204 + Broadcast review.deleted', async () => {
    (getReviewMeta as jest.Mock).mockResolvedValueOnce(meta({ requester_id: 'wer-anders', status: 'in_review' }));
    (deleteReview as jest.Mock).mockResolvedValueOnce(true);
    const res = await request(app).delete(`/api/reviews/${RID}`);
    expect(res.status).toBe(204);
    expect(deleteReview).toHaveBeenCalledWith(RID);
    expect(broadcastToSession).toHaveBeenCalledWith(SID, expect.objectContaining({ type: 'review.deleted' }));
  });

  describe('Enforce-Modus (echte Rollen)', () => {
    beforeEach(() => { process.env.DEV_ENFORCE_ROLES = 'true'; });
    afterEach(() => { delete process.env.DEV_ENFORCE_ROLES; });

    it('Anfrager löscht solange offen → 204', async () => {
      (getReviewMeta as jest.Mock).mockResolvedValueOnce(meta({ status: 'offen' }));
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ role: 'member' }] }); // getSessionRole → nicht owner
      (deleteReview as jest.Mock).mockResolvedValueOnce(true);
      const res = await request(app).delete(`/api/reviews/${RID}`);
      expect(res.status).toBe(204);
    });

    it('Anfrager, aber schon in_review → 403', async () => {
      (getReviewMeta as jest.Mock).mockResolvedValueOnce(meta({ status: 'in_review' }));
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ role: 'member' }] });
      const res = await request(app).delete(`/api/reviews/${RID}`);
      expect(res.status).toBe(403);
      expect(deleteReview).not.toHaveBeenCalled();
    });

    it('Fremder (nicht Anfrager/Owner) → 403', async () => {
      (getReviewMeta as jest.Mock).mockResolvedValueOnce(meta({ requester_id: 'jemand-anders', status: 'offen' }));
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ role: 'member' }] });
      const res = await request(app).delete(`/api/reviews/${RID}`);
      expect(res.status).toBe(403);
      expect(deleteReview).not.toHaveBeenCalled();
    });
  });
});
