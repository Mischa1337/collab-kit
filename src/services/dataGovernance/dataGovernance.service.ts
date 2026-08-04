// M21 — Aufbewahrung & Datenschutz (DSGVO).
// Backend-Logik für: (1) Aufbewahrungsjob (Speicherbegrenzung, Art. 5) und
// (2) nutzerbezogene Anonymisierung (Recht auf Löschung, Art. 17).
import { db } from '../../config/db';
import { logger } from '../../config/logger';

const ANON_PLACEHOLDER = 'deleted-user';

// ── Aufbewahrung (DSGVO Art. 5 — Speicherbegrenzung) ──────────────────────────
// Löscht Sessions ohne Aktivität seit `months` Monaten. Aktivität = documents.updated_at
// (jede Session hat genau ein Dokument). ON DELETE CASCADE räumt documents/comments/
// reviews/history/notifications/session_views automatisch mit auf.
export async function pruneInactiveSessions(months: number): Promise<number> {
  if (!Number.isFinite(months) || months <= 0) {
    throw new Error('months muss eine positive Zahl sein');
  }
  const result = await db.query(
    `DELETE FROM sessions
     WHERE id IN (
       SELECT session_id FROM documents
       WHERE updated_at < NOW() - make_interval(months => $1::int)
     )`,
    [months],
  );
  const deleted = result.rowCount ?? 0;
  logger.info({ months, deleted }, '[M21] Aufbewahrung: inaktive Sessions gelöscht');
  return deleted;
}

// Begrenzt den Change-Feed (Punkt 3): löscht change_log-Einträge älter als `days` —
// auch in *aktiven* Sessions (gelöschte Sessions räumt ON DELETE CASCADE bereits ab).
export async function pruneOldChangeLog(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('days muss eine positive Zahl sein');
  }
  const result = await db.query(
    `DELETE FROM change_log WHERE created_at < NOW() - make_interval(days => $1::int)`,
    [days],
  );
  const deleted = result.rowCount ?? 0;
  logger.info({ days, deleted }, '[M21] change_log: alte Einträge gelöscht');
  return deleted;
}

// ── Recht auf Löschung (DSGVO Art. 17) ────────────────────────────────────────
// Personenbezogene IDs eines Nutzers projektweit ANONYMISIEREN (statt hart löschen →
// wahrt Threads/History/Referenzen). Persönliche Benachrichtigungen + Präsenz werden entfernt.
// Atomar in einer Transaktion (alles oder nichts).
export interface AnonymizeResult {
  sessions: number;
  comments: number;
  comments_resolved: number;
  reviews_requester: number;
  review_feedback: number;
  history: number;
  notifications_deleted: number;
  session_views_deleted: number;
  session_members_deleted: number;
  change_log: number;
  chat_messages: number;
  session_tasks_created: number;
  session_tasks_assigned: number;
  drafts_deleted: number;
}

export async function anonymizeUser(userId: string, placeholder: string = ANON_PLACEHOLDER): Promise<AnonymizeResult> {
  if (!userId || userId === placeholder) {
    throw new Error('userId erforderlich und darf nicht der Platzhalter sein');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const sessions          = await client.query(`UPDATE sessions SET created_by = $2 WHERE created_by = $1`, [userId, placeholder]);
    const comments          = await client.query(`UPDATE comments SET author_id = $2 WHERE author_id = $1`, [userId, placeholder]);
    const commentsResolved  = await client.query(`UPDATE comments SET resolved_by = $2 WHERE resolved_by = $1`, [userId, placeholder]);
    const reviewsRequester  = await client.query(`UPDATE reviews SET requester_id = $2 WHERE requester_id = $1`, [userId, placeholder]);
    // Peer-Review-Umbau: Reviewer stehen in review_feedback (Feedback bleibt, Autor anonymisiert);
    // gezielte Zuweisungen (review_assignees) des Nutzers entfernen.
    const reviewFeedback    = await client.query(`UPDATE review_feedback SET author_id = $2 WHERE author_id = $1`, [userId, placeholder]);
    await client.query(`DELETE FROM review_assignees WHERE user_id = $1`, [userId]);
    const history           = await client.query(`UPDATE history SET author_id = $2 WHERE author_id = $1`, [userId, placeholder]);
    const notifications     = await client.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
    const sessionViews      = await client.query(`DELETE FROM session_views WHERE user_id = $1`, [userId]);
    const sessionMembers    = await client.query(`DELETE FROM session_members WHERE user_id = $1`, [userId]);
    // Punkt 3: Change-Feed anonymisieren (Rows bleiben konsistent erhalten).
    const changeLog         = await client.query(`UPDATE change_log SET who_user_id = $2, who_name = NULL WHERE who_user_id = $1`, [userId, placeholder]);
    // C5 — Session-Chat: Autor anonymisieren (Nachricht bleibt im Verlauf, wie bei Kommentaren).
    const chatMessages      = await client.query(`UPDATE chat_messages SET user_id = $2 WHERE user_id = $1`, [userId, placeholder]);
    // H7 — Aufgaben: Ersteller und Zugewiesenen anonymisieren (Aufgaben bleiben erhalten).
    const tasksCreated      = await client.query(`UPDATE session_tasks SET created_by = $2 WHERE created_by = $1`, [userId, placeholder]);
    const tasksAssigned     = await client.query(`UPDATE session_tasks SET assignee_user_id = $2 WHERE assignee_user_id = $1`, [userId, placeholder]);
    // Privates Arbeitsmodell: eigene Entwürfe löschen (private Arbeitskopie).
    const draftsDeleted     = await client.query(`DELETE FROM session_drafts WHERE user_id = $1`, [userId]);

    await client.query('COMMIT');

    const result: AnonymizeResult = {
      sessions:                sessions.rowCount ?? 0,
      comments:                comments.rowCount ?? 0,
      comments_resolved:       commentsResolved.rowCount ?? 0,
      reviews_requester:       reviewsRequester.rowCount ?? 0,
      review_feedback:         reviewFeedback.rowCount ?? 0,
      history:                 history.rowCount ?? 0,
      notifications_deleted:   notifications.rowCount ?? 0,
      session_views_deleted:   sessionViews.rowCount ?? 0,
      session_members_deleted: sessionMembers.rowCount ?? 0,
      change_log:              changeLog.rowCount ?? 0,
      chat_messages:           chatMessages.rowCount ?? 0,
      session_tasks_created:   tasksCreated.rowCount ?? 0,
      session_tasks_assigned:  tasksAssigned.rowCount ?? 0,
      drafts_deleted:          draftsDeleted.rowCount ?? 0,
    };
    logger.info({ userId, result }, '[M21] DSGVO-Anonymisierung abgeschlossen');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err, userId }, '[M21] Anonymisierung fehlgeschlagen — Rollback');
    throw err;
  } finally {
    client.release();
  }
}
