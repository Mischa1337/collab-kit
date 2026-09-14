// M17 — Notification-Service: erzeugt und verwaltet dauerhafte Benachrichtigungen.
// Die Event-Helfer (notify*) werden von den comments/reviews-Routen aufgerufen und sind
// bewusst "best-effort": Schlägt das Benachrichtigen fehl, bricht die Hauptaktion NICHT ab.
import { db } from '../../config/db';
import { logger } from '../../config/logger';

const NOTIF_COLS = 'id, user_id, session_id, type, ref_id, data, read_at, created_at';

// Minimale Formen der übergebenen Objekte (kommen aus DB-Rows der jeweiligen Route).
interface CommentLike { id: string; session_id: string; author_id: string; parent_id: string | null; content?: string; }
interface ReviewLike { id: string; session_id: string; requester_id: string; }

// ── Low-level ────────────────────────────────────────────────────────────────
export async function createNotification(
  userId: string,
  sessionId: string,
  type: string,
  refId: string | null = null,
  data: Record<string, unknown> | null = null,
) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, session_id, type, ref_id, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING ${NOTIF_COLS}`,
    [userId, sessionId, type, refId, data ? JSON.stringify(data) : null],
  );
  return rows[0];
}

// ── Abfragen für die REST-API ────────────────────────────────────────────────
export async function listNotifications(userId: string, opts: { unreadOnly?: boolean } = {}) {
  const { rows } = await db.query(
    `SELECT ${NOTIF_COLS} FROM notifications
     WHERE user_id = $1 ${opts.unreadOnly ? 'AND read_at IS NULL' : ''}
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId],
  );
  return rows;
}

export async function countUnread(userId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return rows[0]?.count ?? 0;
}

// Markiert eine eigene, ungelesene Benachrichtigung als gelesen.
// Gibt null zurück wenn sie nicht existiert, nicht dem Nutzer gehört oder schon gelesen ist.
export async function markNotificationRead(id: string, userId: string) {
  const { rows } = await db.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL
     RETURNING ${NOTIF_COLS}`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function markAllRead(userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}

// ── M17-Extra: "Seit deinem letzten Besuch" ──────────────────────────────────
// Merkt sich, wann der Nutzer die Session zuletzt gesehen hat.
export async function markSessionSeen(userId: string, sessionId: string): Promise<void> {
  await db.query(
    `INSERT INTO session_views (user_id, session_id, last_seen_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, session_id) DO UPDATE SET last_seen_at = NOW()`,
    [userId, sessionId],
  );
}

// Zählt, was seit dem letzten Besuch von ANDEREN passiert ist (eigene Aktivität ausgeschlossen).
export async function getSinceLastVisit(userId: string, sessionId: string) {
  const seen = await db.query(
    'SELECT last_seen_at FROM session_views WHERE user_id = $1 AND session_id = $2',
    [userId, sessionId],
  );
  const lastSeen: string | null = seen.rows[0]?.last_seen_at ?? null;
  const since = lastSeen ?? new Date(0).toISOString(); // kein Eintrag → alles gilt als neu

  const [comments, versions, reviews] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS c FROM comments WHERE session_id = $1 AND created_at > $2 AND author_id <> $3`, [sessionId, since, userId]),
    db.query(`SELECT COUNT(*)::int AS c FROM history  WHERE session_id = $1 AND created_at > $2 AND author_id <> $3`, [sessionId, since, userId]),
    db.query(`SELECT COUNT(*)::int AS c FROM reviews  WHERE session_id = $1 AND created_at > $2 AND requester_id <> $3`, [sessionId, since, userId]),
  ]);

  return {
    last_seen_at: lastSeen,
    new_comments: comments.rows[0].c,
    new_versions: versions.rows[0].c,
    new_reviews: reviews.rows[0].c,
  };
}

// ── M17-Extra: Digest (Zusammenfassung ungelesener Benachrichtigungen) ────────
// Erzeugt den Digest-INHALT. Der tatsächliche E-Mail-Versand (SMTP) ist eine separate
// Aktivierung — analog zu M12 ist die Mechanik hier, die externe Anbindung wird konfiguriert.
export async function buildDigest(userId: string) {
  const unread = await listNotifications(userId, { unreadOnly: true });
  if (unread.length === 0) {
    return { count: 0, subject: 'Keine neuen Benachrichtigungen', lines: [] as string[] };
  }
  const byType = new Map<string, number>();
  for (const n of unread) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
  const lines = [...byType.entries()].map(([type, c]) => `${c}× ${type}`);
  return {
    count: unread.length,
    subject: `Collab Kit: ${unread.length} ungelesene Benachrichtigung${unread.length === 1 ? '' : 'en'}`,
    lines,
  };
}

// ── Event-Helfer (best-effort, werfen NIE) ───────────────────────────────────
async function safeNotify(userId: string | null | undefined, sessionId: string, type: string, refId: string | null, data: Record<string, unknown> | null = null) {
  if (!userId) return;
  try {
    await createNotification(userId, sessionId, type, refId, data);
  } catch (err) {
    logger.error({ err, userId, type }, '[Notifications] Erstellen fehlgeschlagen');
  }
}

// Schicht-2-Konflikt (A2) → das Opfer dauerhaft informieren (Notification-Center), damit ein
// überschriebener/gelöschter Beitrag nicht nur als flüchtiger Live-Hinweis erscheint. `data` trägt
// Wer (actor) + Was (detail) für einen klaren Glocken-Text.
export async function notifyConflict(victimUserId: string | null | undefined, sessionId: string, refId: string | null = null, data: Record<string, unknown> | null = null): Promise<void> {
  await safeNotify(victimUserId, sessionId, 'conflict', refId, data);
}

// Aufgabe zugewiesen (H7) → den Zugewiesenen dauerhaft informieren (Glocke), außer er weist sich selbst zu.
// data.actor + data.detail ergeben im Frontend den Text „<actor> hat dir die Aufgabe ‚…' zugewiesen".
export async function notifyTaskAssigned(
  assigneeUserId: string | null | undefined,
  sessionId: string,
  taskId: string,
  actorUserId: string,
  title: string,
): Promise<void> {
  if (!assigneeUserId || assigneeUserId === actorUserId) return;
  await safeNotify(assigneeUserId, sessionId, 'task_assigned', taskId, {
    actor: actorUserId,
    detail: `dir die Aufgabe „${title}" zugewiesen`,
  });
}

// Neuer Wurzelkommentar → Session-Ersteller informieren (außer er ist selbst der Autor).
export async function notifyNewComment(comment: CommentLike): Promise<void> {
  try {
    const { rows } = await db.query('SELECT created_by FROM sessions WHERE id = $1', [comment.session_id]);
    const creator = rows[0]?.created_by as string | undefined;
    if (creator && creator !== comment.author_id) {
      await safeNotify(creator, comment.session_id, 'new_comment', comment.id);
    }
  } catch (err) {
    logger.error({ err }, '[Notifications] notifyNewComment');
  }
}

// Antwort in einem Thread → Autor des Ursprungskommentars informieren (außer er antwortet selbst).
export async function notifyCommentReply(comment: CommentLike): Promise<void> {
  try {
    const { rows } = await db.query('SELECT author_id FROM comments WHERE id = $1', [comment.parent_id]);
    const parentAuthor = rows[0]?.author_id as string | undefined;
    if (parentAuthor && parentAuthor !== comment.author_id) {
      await safeNotify(parentAuthor, comment.session_id, 'comment_reply', comment.id);
    }
  } catch (err) {
    logger.error({ err }, '[Notifications] notifyCommentReply');
  }
}

// @-Erwähnung im Kommentar → genannte Nutzer informieren (M18).
// Der @-Token wird als Nutzer-ID interpretiert (das Frontend fügt die stabile ID ein und rendert den Namen).
export function extractMentions(content: string): string[] {
  const ids = new Set<string>();
  const re = /@([a-zA-Z0-9_.-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) ids.add(match[1]);
  return [...ids];
}

export async function notifyMentions(comment: CommentLike): Promise<void> {
  for (const userId of extractMentions(comment.content ?? '')) {
    if (userId !== comment.author_id) {
      await safeNotify(userId, comment.session_id, 'mention', comment.id);
    }
  }
}

// Neue Review-Anfrage → gezielt angefragte Reviewer informieren (bzw. den Session-Ersteller).
export async function notifyReviewCreated(review: ReviewLike, assignees: string[] = []): Promise<void> {
  try {
    if (assignees.length > 0) {
      for (const u of assignees) {
        if (u !== review.requester_id) await safeNotify(u, review.session_id, 'review_requested', review.id, { actor: review.requester_id, detail: 'dich gezielt um ein Review gebeten' });
      }
      return;
    }
    // audience='all': den Session-Ersteller informieren (außer er ist selbst der Anfragende).
    const { rows } = await db.query('SELECT created_by FROM sessions WHERE id = $1', [review.session_id]);
    const creator = rows[0]?.created_by as string | undefined;
    if (creator && creator !== review.requester_id) {
      await safeNotify(creator, review.session_id, 'review_requested', review.id, { actor: review.requester_id, detail: 'um ein Review gebeten (an alle)' });
    }
  } catch (err) {
    logger.error({ err }, '[Notifications] notifyReviewCreated');
  }
}

// Feedback gegeben → den Anfragenden informieren (nicht, wenn er selbst der Reviewer war).
export async function notifyReviewFeedback(review: ReviewLike, authorId?: string): Promise<void> {
  if (review.requester_id && review.requester_id !== authorId) {
    await safeNotify(review.requester_id, review.session_id, 'review_feedback', review.id, { actor: authorId, detail: 'dir Feedback zu deinem Review gegeben' });
  }
}
