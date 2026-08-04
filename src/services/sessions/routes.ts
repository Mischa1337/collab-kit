// Session-Service: verwaltet Kollaborations-Sessions
import { Router, Request, Response } from 'express';
import { sendError } from '../../utils/http';
import { randomUUID } from 'crypto';
import { db } from '../../config/db';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { getReviewCommentsBatch } from '../comments/comments.repository';
import { getFeedbackByReviewIds, getAssigneesByReviewIds } from '../reviews/review.service';
import { checkSessionOwner, requireSessionMember, getSessionRole } from '../../middleware/authorization';
import { disconnectUserFromSession, notifyRoleChange } from '../websocket/controller';
import { broadcastToSession } from '../../utils/broadcast';
import { acknowledgeConflict } from '../collaboration/modelTracker';
import { settings } from '../../config/settings';

const INVITE_TTL_SECONDS = settings.invite.ttlSeconds; // Default 7 Tage

export const sessionRoutes = Router();

// Aktive Nutzer einer Session aus den Redis-Präsenz-Keys (instanz-übergreifend, im
// Gegensatz zu den reinen In-Memory-Zählern). Key-Format: presence:{sessionId}:{userId}:{connId}
// — mehrere Tabs eines Nutzers erzeugen mehrere Keys, daher Deduplizierung über die userId.
async function getActiveUsers(sessionId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `presence:${sessionId}:*`, 'COUNT', 100);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return [...new Set(keys.map((key) => key.split(':')[2]))];
}

// POST /sessions — neue Session erstellen
sessionRoutes.post('/', async (req: Request, res: Response) => {
  const { name } = req.body;
  const created_by = req.user!.id;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    sendError(res, 400, 'name ist ein Pflichtfeld und muss ein String sein');
    return;
  }

  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');

    const sessionResult = await client.query(
      `INSERT INTO sessions (name, created_by)
       VALUES ($1, $2)
       RETURNING id, name, created_by, created_at`,
      [name, created_by]
    );
    const session = sessionResult.rows[0];

    await client.query(
      `INSERT INTO documents (session_id, version) VALUES ($1, 0)`,
      [session.id]
    );

    await client.query(
      `INSERT INTO session_members (session_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [session.id, created_by]
    );

    await client.query('COMMIT');
    logger.info({ sessionId: session.id }, '[Sessions] Neue Session erstellt');

    res.status(201).json({
      id: session.id,
      name: session.name,
      created_by: session.created_by,
      created_at: session.created_at,
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: error }, '[Sessions] Fehler beim Erstellen');
    sendError(res, 500, 'Interner Serverfehler');
  } finally {
    if (client) client.release();
  }
});

// GET /sessions[?member=me] — Sessions, in denen der anfragende Nutzer Mitglied ist (C4 / H8)
sessionRoutes.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.created_at, m.role
       FROM session_members m JOIN sessions s ON s.id = m.session_id
       WHERE m.user_id = $1
       ORDER BY s.created_at DESC`,
      [userId],
    );
    // H8: aktive Nutzer je Session aus den Präsenz-Keys ergänzen (Dashboard-Übersicht).
    const enriched = await Promise.all(
      rows.map(async (s: { id: string }) => ({ ...s, active_users: await getActiveUsers(s.id) })),
    );
    // ?active=true → nur Sessions mit mindestens einem aktiven Nutzer.
    const result = req.query.active === 'true'
      ? enriched.filter((s) => s.active_users.length > 0)
      : enriched;
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '[Sessions] Übersicht Fehler');
    sendError(res, 500, 'Interner Serverfehler');
  }
});

// GET /sessions/:id — Session abrufen
sessionRoutes.get('/:id', requireSessionMember, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const sessionResult = await db.query(
      `SELECT id, name, created_by, created_at, comments_hidden_for_reviewers
       FROM sessions
       WHERE id = $1`,
      [id]
    );

    if (sessionResult.rows.length === 0) {
      sendError(res, 404, 'Session nicht gefunden');
      return;
    }

    const session = sessionResult.rows[0];

    // Aktive Nutzer aus den Redis-Präsenz-Keys (siehe getActiveUsers).
    const activeUsers = await getActiveUsers(id);

    res.status(200).json({
      id: session.id,
      name: session.name,
      created_by: session.created_by,
      created_at: session.created_at,
      active_users: activeUsers,
      your_role: await getSessionRole(req.user!.id, id), // C1: Rolle des Aufrufers (Dev: 'owner')
      comments_hidden_for_reviewers: session.comments_hidden_for_reviewers, // Schalter-Stand für die UI
    });
  } catch (error) {
    logger.error({ err: error }, '[Sessions] Fehler beim Abrufen');
    sendError(res, 500, 'Interner Serverfehler');
  }
});

// DELETE /sessions/:id — Session löschen (nur der Ersteller)
// Löscht automatisch via ON DELETE CASCADE: Dokument, Kommentare, Reviews, History
sessionRoutes.delete('/:id', requireSessionMember, async (req: Request, res: Response) => {
  const { id } = req.params;
  const requestingUserId = req.user!.id;

  try {
    const result = await db.query(
      `DELETE FROM sessions WHERE id = $1 AND created_by = $2 RETURNING id`,
      [id, requestingUserId]
    );

    if (result.rows.length > 0) {
      // Snapshot löschen — presence-Keys laufen via TTL ab
      await redis.del(`session:${id}:snapshot`);
      logger.info({ sessionId: id }, '[Sessions] Session gelöscht');
      res.status(204).send();
      return;
    }

    const existing = await db.query(`SELECT id FROM sessions WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      sendError(res, 404, 'Session nicht gefunden');
    } else {
      sendError(res, 403, 'Nur der Ersteller darf die Session löschen');
    }
  } catch (error) {
    logger.error({ err: error }, '[Sessions] Fehler beim Löschen');
    sendError(res, 500, 'Interner Serverfehler');
  }
});

// GET /api/sessions/:id/reviews — Reviews der Session inkl. Kommentare (M23)
sessionRoutes.get('/:id/reviews', requireSessionMember, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT r.id, r.session_id, r.requester_id, r.status, r.version_id, r.audience, r.created_at,
              h.version_number
       FROM reviews r
       LEFT JOIN history h ON h.id = r.version_id
       WHERE r.session_id = $1
       ORDER BY r.created_at DESC`,
      [id]
    );
    // Alles in EINER Abfrage je Relation laden (kein N+1): Kommentare, Feedbacks, Assignees.
    const reviewIds = result.rows.map((r: { id: string }) => r.id);
    const [commentsByReview, feedbackByReview, assigneesByReview] = await Promise.all([
      getReviewCommentsBatch(reviewIds),
      getFeedbackByReviewIds(reviewIds),
      getAssigneesByReviewIds(reviewIds),
    ]);
    const reviews = result.rows.map((review: { id: string; version_number: number | null }) => ({
      ...review,
      version_number: review.version_number != null ? Number(review.version_number) : null,
      assignees: assigneesByReview.get(review.id) ?? [],
      feedback: feedbackByReview.get(review.id) ?? [],
      ...commentsByReview.get(review.id),
    }));
    res.json(reviews);
  } catch (err) {
    logger.error({ err }, '[Sessions] Reviews laden Fehler');
    sendError(res, 500, 'Reviews konnten nicht geladen werden');
  }
});

// PATCH /sessions/:id/comment-visibility — Team-Kommentare für commentator aus-/einblenden (nur Owner).
sessionRoutes.patch('/:id/comment-visibility', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { hidden } = req.body ?? {};
  if (typeof hidden !== 'boolean') {
    sendError(res, 400, 'hidden muss ein Boolean sein');
    return;
  }
  try {
    if (!await checkSessionOwner(req.user!.id, id)) {
      sendError(res, 403, 'Nur der Owner darf die Kommentar-Sichtbarkeit ändern');
      return;
    }
    await db.query('UPDATE sessions SET comments_hidden_for_reviewers = $1 WHERE id = $2', [hidden, id]);
    broadcastToSession(id, { type: 'comment-visibility.changed', payload: { hidden } });
    res.json({ comments_hidden_for_reviewers: hidden });
  } catch (err) {
    logger.error({ err, sessionId: id }, '[Sessions] Kommentar-Sichtbarkeit Fehler');
    sendError(res, 500, 'Sichtbarkeit konnte nicht geändert werden');
  }
});

// POST /sessions/:id/conflicts/ack { elementId?, edgeId? } — quittiert einen Konflikt-Dialog für
// den aktuellen Nutzer (z.B. Klick auf "Behalten"/"Verwerfen"), damit derselbe Konflikt (Element +
// dieses Opfer) nicht kurz danach erneut auftaucht (siehe modelTracker.ts Cooldown/Dedup).
sessionRoutes.post('/:id/conflicts/ack', requireSessionMember, async (req: Request, res: Response) => {
  const { id } = req.params;
  const elementId = typeof req.body.elementId === 'string' ? req.body.elementId : undefined;
  const edgeId = typeof req.body.edgeId === 'string' ? req.body.edgeId : undefined;
  const key = elementId ?? edgeId;
  if (!key) {
    sendError(res, 400, 'elementId oder edgeId erforderlich');
    return;
  }
  acknowledgeConflict(id, key, req.user!.id);
  res.status(204).send();
});

// GET /sessions/:id/members — Mitgliederliste. Für ALLE Mitglieder lesbar (Owner-Rollen-UI + der
// Assignee-Picker der Aufgaben brauchen die Liste). Mutationen (Rolle ändern/entfernen) bleiben owner-only.
sessionRoutes.get('/:id/members', requireSessionMember, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT user_id, role, added_at FROM session_members WHERE session_id = $1 ORDER BY added_at ASC`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err, sessionId: id }, '[Sessions] Mitgliederliste Fehler');
    sendError(res, 500, 'Mitgliederliste konnte nicht geladen werden');
  }
});

// POST /sessions/:id/members — Mitglied hinzufügen (nur Owner). Optionale Rolle: member|commentator|spectator.
const ASSIGNABLE_ROLES = ['member', 'commentator', 'spectator'] as const;
sessionRoutes.post('/:id/members', async (req: Request, res: Response) => {
  const { id } = req.params;
  const requestingUserId = req.user!.id;
  const { userId, role } = req.body;

  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    sendError(res, 400, 'userId ist ein Pflichtfeld');
    return;
  }
  // Rolle optional; 'owner' wird hier bewusst nicht vergeben (entsteht nur beim Anlegen).
  const assignedRole = role ?? 'member';
  if (!ASSIGNABLE_ROLES.includes(assignedRole)) {
    sendError(res, 400, `role muss eine von ${ASSIGNABLE_ROLES.join('|')} sein`);
    return;
  }

  try {
    if (!await checkSessionOwner(requestingUserId, id)) {
      sendError(res, 403, 'Nur der Owner darf Mitglieder hinzufügen');
      return;
    }

    // Upsert: vorhandenes Mitglied bekommt ggf. die neue Rolle (z.B. member -> commentator).
    await db.query(
      `INSERT INTO session_members (session_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (session_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [id, userId, assignedRole]
    );
    // Rolle live über den offenen /events-Socket pushen (FE reagiert sofort) + nur /sync neu verbinden
    // lassen, damit die serverseitige Schreib-Sperre frisch greift. Robuster als „beide Kanäle kappen".
    await notifyRoleChange(id, userId);
    res.status(204).send();
  } catch (err) {
    logger.error({ err, sessionId: id }, '[Sessions] Mitglied hinzufügen Fehler');
    sendError(res, 500, 'Mitglied konnte nicht hinzugefügt werden');
  }
});

// DELETE /sessions/:id/members/:userId — Mitglied entfernen (nur Owner, ein Query statt zwei)
sessionRoutes.delete('/:id/members/:userId', async (req: Request, res: Response) => {
  const { id, userId } = req.params;
  const requestingUserId = req.user!.id;

  try {
    if (!await checkSessionOwner(requestingUserId, id)) {
      sendError(res, 403, 'Nur der Owner darf Mitglieder entfernen');
      return;
    }

    if (userId === requestingUserId) {
      sendError(res, 400, 'Owner kann sich nicht selbst entfernen');
      return;
    }

    const memberCheck = await db.query(
      `SELECT role FROM session_members WHERE session_id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (memberCheck.rows.length === 0) {
      sendError(res, 404, 'Mitglied nicht gefunden');
      return;
    }
    if (memberCheck.rows[0].role === 'owner') {
      sendError(res, 403, 'Owner kann nicht entfernt werden');
      return;
    }

    await db.query(
      `DELETE FROM session_members WHERE session_id = $1 AND user_id = $2`,
      [id, userId]
    );
    disconnectUserFromSession(id, userId); // WS sonst weiter offen trotz entzogener Mitgliedschaft
    res.status(204).send();
  } catch (err) {
    logger.error({ err, sessionId: id }, '[Sessions] Mitglied entfernen Fehler');
    sendError(res, 500, 'Mitglied konnte nicht entfernt werden');
  }
});

// POST /sessions/:id/invite — Einladungs-Token erzeugen (nur Owner). Optionale Rolle für Beitretende.
sessionRoutes.post('/:id/invite', async (req: Request, res: Response) => {
  const { id } = req.params;
  const role = req.body?.role ?? 'member';
  if (!ASSIGNABLE_ROLES.includes(role)) {
    sendError(res, 400, `role muss eine von ${ASSIGNABLE_ROLES.join('|')} sein`);
    return;
  }
  try {
    if (!await checkSessionOwner(req.user!.id, id)) {
      sendError(res, 403, 'Nur der Owner darf einladen');
      return;
    }
    const token = randomUUID();
    await redis.set(`invite:${token}`, JSON.stringify({ sessionId: id, role }), 'EX', INVITE_TTL_SECONDS);
    res.status(201).json({ token, expires_at: new Date(Date.now() + INVITE_TTL_SECONDS * 1000).toISOString() });
  } catch (err) {
    logger.error({ err, sessionId: id }, '[Sessions] Einladung Fehler');
    sendError(res, 500, 'Einladung konnte nicht erstellt werden');
  }
});

// POST /sessions/:id/join — per Token beitreten (kein Mitgliedschaftszwang — man tritt ja gerade bei).
sessionRoutes.post('/:id/join', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { token } = req.body ?? {};
  if (!token || typeof token !== 'string') {
    sendError(res, 400, 'token ist ein Pflichtfeld');
    return;
  }
  try {
    const raw = await redis.get(`invite:${token}`);
    if (!raw) {
      sendError(res, 404, 'Ungültiges oder abgelaufenes Token');
      return;
    }
    const invite = JSON.parse(raw) as { sessionId: string; role: string };
    if (invite.sessionId !== id) {
      sendError(res, 400, 'Token gehört nicht zu dieser Session');
      return;
    }
    await db.query(
      `INSERT INTO session_members (session_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, req.user!.id, invite.role],
    );
    res.status(200).json({ role: invite.role });
  } catch (err) {
    logger.error({ err, sessionId: id }, '[Sessions] Beitritt Fehler');
    sendError(res, 500, 'Beitritt fehlgeschlagen');
  }
});

// POST /sessions/:id/join-self — Beitritt allein durch Kenntnis der Session-ID, ohne Einladungstoken.
// Bewusste Design-Entscheidung (kein N1-Bug): wer die ID hat, wird Mitglied mit der Standardrolle
// 'spectator' (nur zusehen, keine Rechte) — der Owner kann die Rolle danach im Mitglieder-Panel
// gezielt hochstufen. Bereits bestehende Mitglieder (z.B. der owner) bleiben durch ON CONFLICT unverändert.
sessionRoutes.post('/:id/join-self', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const existing = await db.query(`SELECT id FROM sessions WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      sendError(res, 404, 'Session nicht gefunden');
      return;
    }
    await db.query(
      `INSERT INTO session_members (session_id, user_id, role) VALUES ($1, $2, 'spectator') ON CONFLICT DO NOTHING`,
      [id, req.user!.id],
    );
    res.status(200).json({ role: await getSessionRole(req.user!.id, id) });
  } catch (err) {
    logger.error({ err, sessionId: id }, '[Sessions] Selbst-Beitritt Fehler');
    sendError(res, 500, 'Beitritt fehlgeschlagen');
  }
});
