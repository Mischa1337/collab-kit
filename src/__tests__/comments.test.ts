// M8 — Kommentar-Service Tests (REST-API)
// Prüft POST, GET und DELETE /api/comments bzw. /api/sessions/:id/comments.
// DB und Redis werden gemockt — kein laufender Docker nötig.
import request from 'supertest';
import { app } from '../app';
import { db } from '../config/db';

// db.query wird durch eine Jest-Funktion ersetzt, die wir pro Test mit Fake-Daten befüllen.
jest.mock('../config/db', () => ({
  db: { query: jest.fn() },
}));

// Redis wird gemockt — kein echter Pub/Sub nötig im Test.
jest.mock('../config/redis', () => ({
  redis: {
    publish: jest.fn().mockResolvedValue(1),
  },
  subscriber: {
    on: jest.fn(),
    psubscribe: jest.fn().mockResolvedValue(undefined),
  },
  connectRedis: jest.fn().mockResolvedValue(undefined),
}));

// Broadcast-Util mocken damit broadcastToSession-Aufrufe überprüft werden können.
jest.mock('../utils/broadcast', () => ({
  broadcastToSession: jest.fn(),
}));

// M17: Notification-Service mocken — die Wiring-Aufrufe der Route sollen hier KEINE
// zusätzlichen db.query-Aufrufe auslösen (sonst verrutscht die mockResolvedValueOnce-Queue).
jest.mock('../services/notifications/notification.service', () => ({
  notifyNewComment: jest.fn(),
  notifyCommentReply: jest.fn(),
  notifyMentions: jest.fn(),
}));

// Rolle steuerbar machen (Default 'owner' = Verhalten wie im Dev-Modus); Rest der Authorization echt.
jest.mock('../middleware/authorization', () => {
  const actual = jest.requireActual('../middleware/authorization');
  return { ...actual, getSessionRole: jest.fn().mockResolvedValue('owner') };
});

import { broadcastToSession } from '../utils/broadcast';
import { getSessionRole } from '../middleware/authorization';

// Wiederverwendbarer Fake-Kommentar — entspricht dem was die DB zurückgeben würde.
const FAKE_COMMENT = {
  id: 'comment-uuid-123',
  session_id: 'session-uuid-456',
  author_id: 'dev-user',
  content: 'Testkommentar',
  position: { line: 1, character: 1 },
  created_at: '2026-05-15T10:00:00.000Z',
};

describe('M8 — Kommentar-Service (REST)', () => {

  describe('POST /api/sessions/:id/comments', () => {
    // Hauptpfad: Kommentar mit allen Pflichtfeldern erstellen → DB schreibt, Server antwortet mit 201.
    it('erstellt einen Kommentar und gibt 201 zurück', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE_COMMENT] });

      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Testkommentar', position: { line: 1, character: 1 } });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('comment-uuid-123');
      expect(res.body.content).toBe('Testkommentar');
      expect(res.body.author_id).toBe('dev-user');
    });

    // Robustheit: wenn die DB nicht erreichbar ist, muss der Server kontrolliert mit 500 antworten.
    it('gibt 500 zurück bei Datenbankfehler', async () => {
      (db.query as jest.Mock).mockRejectedValueOnce(new Error('DB nicht erreichbar'));

      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Testkommentar' });

      expect(res.status).toBe(500);
    });

    // Abnahmekriterium M8 #1: Kommentar anlegen → erscheint sofort bei allen anderen Nutzern.
    it('sendet nach erfolgreichem Speichern einen WebSocket-Broadcast an die Session', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE_COMMENT] });

      await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Testkommentar', position: { line: 1, character: 1 } });

      expect(broadcastToSession).toHaveBeenCalledWith(
        'session-uuid-456',
        expect.objectContaining({ type: 'comment.created', payload: FAKE_COMMENT })
      );
    });

    // Sicherheitscheck: bei einem DB-Fehler darf kein halbfertiger Broadcast rausgehen.
    it('sendet keinen Broadcast wenn die Datenbank einen Fehler wirft', async () => {
      (db.query as jest.Mock).mockRejectedValueOnce(new Error('DB nicht erreichbar'));

      await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Testkommentar' });

      expect(broadcastToSession).not.toHaveBeenCalled();
    });

    // Abnahmekriterium M8: content ist Pflichtfeld — ohne Inhalt kein Kommentar.
    // HINWEIS: Erfordert Validierung in comments/routes.ts:
    //   if (!content || content.trim().length === 0) return res.status(400).json(...)
    it('gibt 400 zurück wenn content fehlt', async () => {
      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ position: { line: 1, character: 1 } });

      expect(res.status).toBe(400);
    });

    // Nur aus Leerzeichen bestehender content ist kein gültiger Kommentar.
    it('gibt 400 zurück wenn content nur aus Leerzeichen besteht', async () => {
      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: '   ', position: { line: 1, character: 1 } });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/sessions/:id/comments', () => {
    // Normalfall: Session hat Kommentare → alle werden zurückgegeben.
    it('gibt alle Kommentare einer Session zurück', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE_COMMENT] });

      const res = await request(app).get('/api/sessions/session-uuid-456/comments');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe('comment-uuid-123');
    });

    // Edge Case: Session hat noch keine Kommentare → leeres Array, kein Fehler.
    it('gibt leeres Array zurück wenn keine Kommentare existieren', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/sessions/session-uuid-456/comments');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    // Globaler Schalter: reviewer sieht bei ausgeblendeten Kommentaren NICHTS.
    it('reviewer + ausgeblendet → leeres Array (keine Kommentar-Abfrage)', async () => {
      (getSessionRole as jest.Mock).mockResolvedValueOnce('commentator');
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ comments_hidden_for_reviewers: true }] }); // Session-Flag
      const res = await request(app).get('/api/sessions/session-uuid-456/comments');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    // reviewer + NICHT ausgeblendet → sieht die Kommentare ganz normal.
    it('reviewer + nicht ausgeblendet → Kommentare sichtbar', async () => {
      (getSessionRole as jest.Mock).mockResolvedValueOnce('commentator');
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ comments_hidden_for_reviewers: false }] }) // Flag
        .mockResolvedValueOnce({ rows: [FAKE_COMMENT] });                              // comments
      const res = await request(app).get('/api/sessions/session-uuid-456/comments');
      expect(res.body).toHaveLength(1);
    });
  });

  describe('PATCH /api/sessions/:id/comment-visibility', () => {
    it('Owner blendet Team-Kommentare für Reviewer aus (200)', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] }); // UPDATE
      const res = await request(app)
        .patch('/api/sessions/session-uuid-456/comment-visibility')
        .send({ hidden: true });
      expect(res.status).toBe(200);
      expect(res.body.comments_hidden_for_reviewers).toBe(true);
    });

    it('gibt 400 ohne boolean hidden', async () => {
      const res = await request(app)
        .patch('/api/sessions/session-uuid-456/comment-visibility')
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/comments/:id', () => {
    // Hauptpfad: eigener Kommentar wird gelöscht → 204 + Broadcast.
    it('löscht eigenen Kommentar und gibt 204 zurück', async () => {
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ author_id: 'dev-user', session_id: 'session-uuid-456' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app).delete('/api/comments/comment-uuid-123');

      expect(res.status).toBe(204);
    });

    // Abnahmekriterium: gelöschter Kommentar erscheint sofort bei allen anderen Clients als entfernt.
    it('sendet nach dem Löschen einen Broadcast mit der korrekten session_id', async () => {
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ author_id: 'dev-user', session_id: 'session-uuid-456' }] })
        .mockResolvedValueOnce({ rows: [] });

      await request(app).delete('/api/comments/comment-uuid-123');

      expect(broadcastToSession).toHaveBeenCalledWith('session-uuid-456', {
        type: 'comment.deleted',
        payload: { id: 'comment-uuid-123' },
      });
    });

    // Sicherheit: kein Broadcast wenn der User nicht der Autor ist.
    it('sendet keinen Broadcast wenn keine Berechtigung vorliegt (403)', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ author_id: 'anderer-user', session_id: 'session-uuid-456' }] });

      await request(app).delete('/api/comments/comment-uuid-123');

      expect(broadcastToSession).not.toHaveBeenCalled();
    });

    // Berechtigungsprüfung: fremder Kommentar darf nicht gelöscht werden → 403.
    it('gibt 403 zurück wenn der Kommentar einem anderen Nutzer gehört', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ author_id: 'anderer-user', session_id: 'session-uuid-456' }] });

      const res = await request(app).delete('/api/comments/comment-uuid-123');

      expect(res.status).toBe(403);
    });

    // Fehlerfall: unbekannte UUID → DB gibt leeres Ergebnis → 404.
    it('gibt 404 zurück wenn der Kommentar nicht existiert', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const res = await request(app).delete('/api/comments/nicht-existent');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/sessions/:id/comments — position-Validierung', () => {
    it('akzeptiert einen Kommentar ohne position (optional)', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [FAKE_COMMENT] });

      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Ohne Position' });

      expect(res.status).toBe(201);
    });

    it('gibt 400 zurück wenn position kein Objekt ist', async () => {
      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Test', position: 'falsch' });

      expect(res.status).toBe(400);
    });

    it('gibt 400 zurück wenn position.line kein Integer ist', async () => {
      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Test', position: { line: 1.5, character: 0 } });

      expect(res.status).toBe(400);
    });

    it('gibt 400 zurück wenn position.line negativ ist', async () => {
      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Test', position: { line: -1, character: 0 } });

      expect(res.status).toBe(400);
    });

    it('gibt 400 zurück wenn position.character fehlt', async () => {
      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Test', position: { line: 1 } });

      expect(res.status).toBe(400);
    });
  });

  // ── M18 — Threads (Antworten) ────────────────────────────────────────────────
  describe('POST /api/sessions/:id/comments — Threads (M18)', () => {
    const PARENT_ID = '11111111-1111-4111-8111-111111111111'; // gültige UUID — wird von der parent_id-Validierung verlangt
    const ROOT_PARENT = { session_id: 'session-uuid-456', parent_id: null };
    const FAKE_REPLY = { ...FAKE_COMMENT, id: 'reply-uuid-1', content: 'Antwort', parent_id: PARENT_ID };

    it('erstellt eine Antwort (parent_id) und löst comment.created mit parent_id aus', async () => {
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [ROOT_PARENT] })   // parent-Existenzprüfung
        .mockResolvedValueOnce({ rows: [FAKE_REPLY] });    // INSERT

      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'Antwort', parent_id: PARENT_ID });

      expect(res.status).toBe(201);
      expect(res.body.parent_id).toBe(PARENT_ID);
      expect(broadcastToSession).toHaveBeenCalledWith(
        'session-uuid-456',
        expect.objectContaining({ type: 'comment.created', payload: expect.objectContaining({ parent_id: PARENT_ID }) })
      );
    });

    it('lehnt eine Antwort auf einen nicht existierenden Kommentar ab (400, kein Broadcast)', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'x', parent_id: PARENT_ID });

      expect(res.status).toBe(400);
      expect(broadcastToSession).not.toHaveBeenCalled();
    });

    it('lehnt eine Antwort auf eine Antwort ab — nur eine Ebene (400)', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ session_id: 'session-uuid-456', parent_id: 'ein-root' }] });

      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'x', parent_id: PARENT_ID });

      expect(res.status).toBe(400);
    });

    it('lehnt parent_id aus einer anderen Session ab (400)', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ session_id: 'andere-session', parent_id: null }] });

      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'x', parent_id: PARENT_ID });

      expect(res.status).toBe(400);
    });

    it('lehnt eine ungültige parent_id-UUID ab (400, ohne DB-Zugriff)', async () => {
      const res = await request(app)
        .post('/api/sessions/session-uuid-456/comments')
        .send({ content: 'x', parent_id: 'kein-uuid' });

      expect(res.status).toBe(400);
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  // ── M18 — Auflösen / Wiederöffnen ────────────────────────────────────────────
  describe('PATCH /api/comments/:id/resolve & /reopen (M18)', () => {
    const OPEN = { ...FAKE_COMMENT, parent_id: null, resolved_at: null, resolved_by: null };
    const RESOLVED = { ...OPEN, resolved_at: '2026-05-15T11:00:00.000Z', resolved_by: 'dev-user' };

    it('markiert einen Kommentar als erledigt (comment.updated, resolved_at gesetzt)', async () => {
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [OPEN] })       // SELECT existing
        .mockResolvedValueOnce({ rows: [RESOLVED] });  // UPDATE

      const res = await request(app).patch('/api/comments/comment-uuid-123/resolve');

      expect(res.status).toBe(200);
      expect(res.body.resolved_at).not.toBeNull();
      expect(broadcastToSession).toHaveBeenCalledWith(
        'session-uuid-456',
        expect.objectContaining({ type: 'comment.updated', payload: expect.objectContaining({ resolved_at: RESOLVED.resolved_at }) })
      );
    });

    it('ist idempotent wenn schon aufgelöst (200, kein Broadcast)', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [RESOLVED] });

      const res = await request(app).patch('/api/comments/comment-uuid-123/resolve');

      expect(res.status).toBe(200);
      expect(broadcastToSession).not.toHaveBeenCalled();
    });

    it('gibt 404 zurück wenn der Kommentar nicht existiert', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const res = await request(app).patch('/api/comments/fehlt/resolve');

      expect(res.status).toBe(404);
    });

    it('öffnet einen aufgelösten Kommentar wieder (comment.updated, resolved_at null)', async () => {
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [RESOLVED] })   // SELECT existing
        .mockResolvedValueOnce({ rows: [OPEN] });      // UPDATE

      const res = await request(app).patch('/api/comments/comment-uuid-123/reopen');

      expect(res.status).toBe(200);
      expect(res.body.resolved_at).toBeNull();
      expect(broadcastToSession).toHaveBeenCalledWith(
        'session-uuid-456',
        expect.objectContaining({ type: 'comment.updated', payload: expect.objectContaining({ resolved_at: null }) })
      );
    });
  });

  // ── M18 — resolved-Filter ────────────────────────────────────────────────────
  describe('GET /api/sessions/:id/comments — resolved-Filter (M18)', () => {
    it('filtert aufgelöste Kommentare wenn ?resolved=false', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await request(app).get('/api/sessions/session-uuid-456/comments?resolved=false');

      expect((db.query as jest.Mock).mock.calls[0][0]).toEqual(expect.stringContaining('resolved_at IS NULL'));
    });
  });

});