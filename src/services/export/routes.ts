// WP2 — Datenexport: Session-/Dokument-Export (Kleppmann „Longevity"/Portabilität)
// + nutzerbezogener Export (DSGVO-Auskunftsrecht, Art. 15) — ergänzt M21.
import { Router, Request, Response, NextFunction } from 'express';
import { sendError } from '../../utils/http';
import * as Y from 'yjs';
import { db } from '../../config/db';
import { requireSessionMember } from '../../middleware/authorization';
import { toPlainModel } from '../collaboration/model.types';

export const exportRoutes = Router();

// Yjs-Snapshot (BYTEA-Buffer) → lesbarer Text. Snapshot wird via Y.encodeStateAsUpdate gespeichert (M6).
function snapshotToText(snapshot: Buffer | null | undefined): string {
  if (!snapshot) return '';
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(snapshot));
  return ydoc.getText('content').toString();
}

// Derselbe Whole-Doc-Snapshot enthält auch das strukturierte Modell (M11) → mit-dekodieren.
function snapshotToModel(snapshot: Buffer | null | undefined): { nodes: unknown[]; edges: unknown[] } {
  if (!snapshot) return { nodes: [], edges: [] };
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(snapshot));
  return toPlainModel(ydoc);
}

function renderMarkdown(
  session: { name: string },
  text: string,
  comments: { content: string; author_id: string }[],
): string {
  let md = `# ${session.name}\n\n${text}\n`;
  if (comments.length > 0) {
    md += '\n## Kommentare\n';
    for (const c of comments) md += `- **${c.author_id}**: ${c.content}\n`;
  }
  return md;
}

/**
 * @route GET /api/sessions/:id/export
 * @desc  Vollständiger Session-Inhalt: Dokument (Text) + Kommentare + Reviews + History.
 * @query {string} [format=json] — `md` liefert Markdown statt JSON.
 * @returns {200} Export-Objekt · {404} Session nicht gefunden
 */
// N1: nur Mitglieder dürfen den Session-Export ziehen (/me/export bleibt nutzer-eigen, ohne Session-Bezug).
exportRoutes.get('/sessions/:id/export', requireSessionMember, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const session = await db.query(
      'SELECT id, name, created_by, created_at FROM sessions WHERE id = $1',
      [id],
    );
    if (session.rows.length === 0) {
      sendError(res, 404, 'Session nicht gefunden');
      return;
    }

    const [doc, comments, reviews, history] = await Promise.all([
      db.query('SELECT content_snapshot, version, updated_at FROM documents WHERE session_id = $1', [id]),
      db.query(
        'SELECT id, author_id, content, position, parent_id, review_id, resolved_at, created_at FROM comments WHERE session_id = $1 ORDER BY created_at ASC',
        [id],
      ),
      db.query(
        'SELECT id, requester_id, status, version_id, audience, created_at FROM reviews WHERE session_id = $1 ORDER BY created_at ASC',
        [id],
      ),
      db.query(
        'SELECT id, version_number, author_id, name, scope, kind, created_at FROM history WHERE session_id = $1 ORDER BY version_number ASC',
        [id],
      ),
    ]);

    const snapshot = doc.rows[0]?.content_snapshot ?? null;
    const text = snapshotToText(snapshot);
    const model = snapshotToModel(snapshot); // M11: Knoten/Kanten aus demselben Snapshot

    if (req.query.format === 'md') {
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      res.send(renderMarkdown(session.rows[0], text, comments.rows));
      return;
    }

    res.json({
      session: session.rows[0],
      document: {
        text,
        model, // { nodes, edges } — leer bei reinen Text-Sessions
        version: doc.rows[0]?.version ?? 0,
        updated_at: doc.rows[0]?.updated_at ?? null,
      },
      comments: comments.rows,
      reviews: reviews.rows,
      history: history.rows,
      exported_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route GET /api/me/export
 * @desc  Alle Daten des anfragenden Nutzers (DSGVO Auskunftsrecht, Art. 15).
 * @returns {200} Nutzer-Datenexport
 */
exportRoutes.get('/me/export', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const [sessions, comments, reviews, notifications, views, chat, tasks, savedStates, reviewFeedback, drafts] = await Promise.all([
      db.query('SELECT id, name, created_at FROM sessions WHERE created_by = $1 ORDER BY created_at ASC', [userId]),
      db.query('SELECT id, session_id, content, created_at FROM comments WHERE author_id = $1 ORDER BY created_at ASC', [userId]),
      db.query(
        'SELECT id, session_id, status, version_id, audience, created_at FROM reviews WHERE requester_id = $1 ORDER BY created_at ASC',
        [userId],
      ),
      db.query('SELECT id, session_id, type, ref_id, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at ASC', [userId]),
      db.query('SELECT session_id, last_seen_at FROM session_views WHERE user_id = $1', [userId]),
      db.query('SELECT id, session_id, content, created_at FROM chat_messages WHERE user_id = $1 ORDER BY created_at ASC', [userId]),
      db.query(
        'SELECT id, session_id, title, status, created_at FROM session_tasks WHERE created_by = $1 OR assignee_user_id = $1 ORDER BY created_at ASC',
        [userId],
      ),
      // Eigene gespeicherte Stände (persönlicher Eimer + selbst angelegte geteilte Stände).
      db.query(
        'SELECT id, session_id, version_number, name, scope, kind, created_at FROM history WHERE author_id = $1 ORDER BY created_at ASC',
        [userId],
      ),
      // Eigene Review-Feedbacks (als Reviewer abgegeben).
      db.query(
        'SELECT id, review_id, feedback, verdict, created_at FROM review_feedback WHERE author_id = $1 ORDER BY created_at ASC',
        [userId],
      ),
      // Eigene private Arbeitsmodelle (Entwürfe).
      db.query('SELECT session_id, updated_at FROM session_drafts WHERE user_id = $1 ORDER BY updated_at ASC', [userId]),
    ]);

    res.json({
      user_id: userId,
      sessions_created: sessions.rows,
      comments: comments.rows,
      reviews: reviews.rows,
      notifications: notifications.rows,
      session_views: views.rows,
      chat_messages: chat.rows,
      tasks: tasks.rows,
      saved_states: savedStates.rows,
      review_feedback: reviewFeedback.rows,
      drafts: drafts.rows,
      exported_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});
