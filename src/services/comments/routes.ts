// Kommentar-Service: Kommentare an Dokument-Stellen, Threads (Antworten) und Auflösen ("erledigt").
// Kommentare sind einer Session zugeordnet und werden dauerhaft in PostgreSQL gespeichert.
import { Request, Response, Router } from 'express';
import { sendError, assertUuid } from '../../utils/http';
import { db } from '../../config/db';
import { logger } from '../../config/logger';
import { broadcastToSession } from '../../utils/broadcast';
import { notifyCommentReply, notifyMentions, notifyNewComment } from '../notifications/notification.service';
import { COMMENT_COLS } from './comments.repository';
import { requireSessionMember, requireComment, canSeeInternal, canSeeComments, getSessionRole, ensureCommenter } from '../../middleware/authorization';

export const commentRoutes = Router();


/**
 * @route   POST /api/sessions/:id/comments
 * @desc    Kommentar anlegen — optional als Antwort (parent_id) auf einen Wurzelkommentar (Thread) oder Review
 * @param   {string} id - Session-ID (URL-Parameter)
 * @body    {string} content - Inhalt des Kommentars
 * @body    {object} [position] - Position im Dokument { line, character }
 * @body    {string} [parent_id] - UUID eines Wurzelkommentars derselben Session → Antwort
 * @body    {string} [review_id] - UUID eines Reviews
 * @returns {201} Neu angelegter Kommentar
 * @returns {400} content/position/parent_id/review_id ungültig
 * @returns {404} Session nicht gefunden (FK-Violation)
 * @returns {500} Datenbankfehler
 */
commentRoutes.post('/sessions/:id/comments', requireComment, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { content, position, parent_id, review_id, node_id } = req.body;
    const author_id = req.user!.id;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
        sendError(res, 400, 'content ist ein Pflichtfeld');
        return;
    }

    if (position !== undefined && position !== null) {
        if (
            typeof position !== 'object' ||
            !Number.isInteger(position.line) ||
            !Number.isInteger(position.character) ||
            position.line < 0 ||
            position.character < 0
        ) {
            sendError(res, 400, 'position muss { line: number, character: number } mit ganzen Zahlen ≥ 0 sein');
            return;
        }
    }

    if (node_id !== undefined && node_id !== null && typeof node_id !== 'string') {
        sendError(res, 400, 'node_id muss ein String sein');
        return;
    }

    if (parent_id != null && !assertUuid(res, parent_id, 'parent_id')) return;

    if (review_id) {
        if (!assertUuid(res, review_id, 'review_id')) return;
        const r = await db.query(
            'SELECT session_id FROM reviews WHERE id = $1',
            [review_id]
        );
        if (r.rows.length === 0 || r.rows[0].session_id !== id) {
            sendError(res, 400, 'review_id ungültig oder gehört zu einer anderen Session');
            return;
        }
    }

    try {
        // Antwort: Wurzelkommentar muss existieren, zur selben Session gehören und selbst Wurzel sein (eine Ebene).
        if (parent_id) {
            const parent = await db.query(
                `SELECT session_id, parent_id FROM comments WHERE id = $1`, [parent_id]
            );
            if (parent.rows.length === 0) {
                sendError(res, 400, 'parent_id verweist auf keinen existierenden Kommentar');
                return;
            }
            if (parent.rows[0].session_id !== id) {
                sendError(res, 400, 'parent_id gehört zu einer anderen Session');
                return;
            }
            if (parent.rows[0].parent_id !== null) {
                sendError(res, 400, 'Antworten sind nur auf Wurzelkommentare erlaubt (eine Ebene)');
                return;
            }
        }

        const result = await db.query(
            `INSERT INTO comments (session_id, author_id, content, position, parent_id, review_id, node_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING ${COMMENT_COLS}`,
            [id, author_id, content, position ?? null, parent_id ?? null, review_id ?? null, node_id ?? null]
        );

        const newComment = result.rows[0];
        // Erstellung (Wurzel oder Antwort) → EIN Event; das FE unterscheidet über payload.parent_id.
        broadcastToSession(id, { type: 'comment.created', payload: newComment });
        // M17: dauerhafte Benachrichtigung (best-effort, blockiert die Antwort nicht).
        if (newComment.parent_id) void notifyCommentReply(newComment);
        else void notifyNewComment(newComment);
        // M18: @-Erwähnungen im Inhalt benachrichtigen.
        void notifyMentions(newComment);
        res.status(201).json(newComment);
    } catch (err) {
        // PostgreSQL FK-Violation (23503): Session existiert nicht
        if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23503') {
            sendError(res, 404, 'Session nicht gefunden');
            return;
        }
        logger.error({ err, sessionId: id }, '[Comments] Fehler beim Erstellen');
        sendError(res, 500, 'Kommentar konnte nicht gespeichert werden');
    }
});


/**
 * @route   GET /api/sessions/:id/comments
 * @desc    Alle Kommentare einer Session (flach, mit parent_id zum Gruppieren im Client)
 * @param   {string} id - Session-ID (URL-Parameter)
 * @query   {string} [resolved] - "false" → nur offene (nicht aufgelöste) Kommentare
 * @returns {200} Array aller Kommentare der Session (leer wenn keine vorhanden)
 * @returns {500} Datenbankfehler
 */
commentRoutes.get('/sessions/:id/comments', requireSessionMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    const onlyOpen = req.query.resolved === 'false';

    try {
        const role = await getSessionRole(req.user!.id, id);
        // spectator sieht keine Kommentare (nur das Modell).
        if (!canSeeComments(role)) {
            sendError(res, 403, 'Diese Rolle darf keine Kommentare sehen');
            return;
        }
        // Globaler Schalter: hat das Team die Kommentare ausgeblendet, sehen commentator keine.
        // owner/member (das Team) sehen immer alles. Dev-Modus: jeder gilt als 'owner'.
        if (!canSeeInternal(role)) {
            const s = await db.query('SELECT comments_hidden_for_reviewers FROM sessions WHERE id = $1', [id]);
            if (s.rows[0]?.comments_hidden_for_reviewers) {
                res.json([]);
                return;
            }
        }
        const result = await db.query(
            `SELECT ${COMMENT_COLS}
             FROM comments
             WHERE session_id = $1 ${onlyOpen ? 'AND resolved_at IS NULL' : ''}
             ORDER BY created_at ASC`,
            [id]
        );
        res.json(result.rows);
    } catch (err) {
        logger.error({ err, sessionId: id }, '[Comments] Fehler beim Abrufen');
        sendError(res, 500, 'Kommentare konnten nicht abgerufen werden');
    }
});


/**
 * @route   PATCH /api/comments/:id/resolve
 * @desc    Kommentar als erledigt markieren (idempotent). Jeder Session-Teilnehmer darf auflösen.
 * @param   {string} id - Kommentar-ID (URL-Parameter)
 * @returns {200} Aktualisierter Kommentar
 * @returns {404} Kommentar nicht gefunden
 * @returns {500} Datenbankfehler
 */
commentRoutes.patch('/comments/:id/resolve', async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;

    try {
        const existing = await db.query(`SELECT ${COMMENT_COLS} FROM comments WHERE id = $1`, [id]);
        if (existing.rows.length === 0) {
            sendError(res, 404, 'Kommentar nicht gefunden');
            return;
        }
        if (!(await ensureCommenter(userId, existing.rows[0].session_id, res))) return;
        // Schon aufgelöst → idempotent: aktuellen Stand zurückgeben, kein erneuter Broadcast.
        if (existing.rows[0].resolved_at !== null) {
            res.json(existing.rows[0]);
            return;
        }

        const result = await db.query(
            `UPDATE comments SET resolved_at = NOW(), resolved_by = $2 WHERE id = $1 RETURNING ${COMMENT_COLS}`,
            [id, userId]
        );
        const updated = result.rows[0];
        broadcastToSession(updated.session_id, { type: 'comment.updated', payload: updated }); // resolved
        res.json(updated);
    } catch (err) {
        logger.error({ err, commentId: id }, '[Comments] Fehler beim Auflösen');
        sendError(res, 500, 'Kommentar konnte nicht aufgelöst werden');
    }
});


/**
 * @route   PATCH /api/comments/:id/reopen
 * @desc    Aufgelösten Kommentar wieder öffnen (idempotent)
 * @param   {string} id - Kommentar-ID (URL-Parameter)
 * @returns {200} Aktualisierter Kommentar
 * @returns {404} Kommentar nicht gefunden
 * @returns {500} Datenbankfehler
 */
commentRoutes.patch('/comments/:id/reopen', async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;

    try {
        const existing = await db.query(`SELECT ${COMMENT_COLS} FROM comments WHERE id = $1`, [id]);
        if (existing.rows.length === 0) {
            sendError(res, 404, 'Kommentar nicht gefunden');
            return;
        }
        if (!(await ensureCommenter(userId, existing.rows[0].session_id, res))) return;
        // Schon offen → idempotent.
        if (existing.rows[0].resolved_at === null) {
            res.json(existing.rows[0]);
            return;
        }

        const result = await db.query(
            `UPDATE comments SET resolved_at = NULL, resolved_by = NULL WHERE id = $1 RETURNING ${COMMENT_COLS}`,
            [id]
        );
        const updated = result.rows[0];
        broadcastToSession(updated.session_id, { type: 'comment.updated', payload: updated }); // reopened
        res.json(updated);
    } catch (err) {
        logger.error({ err, commentId: id }, '[Comments] Fehler beim Wiederöffnen');
        sendError(res, 500, 'Kommentar konnte nicht wiedergeöffnet werden');
    }
});


/**
 * @route   DELETE /api/comments/:id
 * @desc    Einzelnen Kommentar löschen. Nur der Autor des Kommentars darf ihn löschen.
 * ON DELETE CASCADE entfernt auch dessen Antworten.
 * @param   {string} id - Kommentar-ID (URL-Parameter)
 * @returns {204} Erfolgreich gelöscht, kein Inhalt
 * @returns {403} Anfragender User ist nicht der Autor
 * @returns {404} Kommentar nicht gefunden
 * @returns {500} Datenbankfehler
 */
commentRoutes.delete('/comments/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const author_id = req.user!.id;

    try {
        const existing = await db.query(
            `SELECT author_id, session_id FROM comments WHERE id = $1`, [id]
        );
        if (existing.rows.length === 0) {
            sendError(res, 404, 'Kommentar nicht gefunden');
            return;
        }

        if (existing.rows[0].author_id !== author_id) {
            sendError(res, 403, 'Keine Berechtigung zum Löschen des Kommentars');
            return;
        }

        await db.query(`DELETE FROM comments WHERE id = $1`, [id]);
        broadcastToSession(existing.rows[0].session_id, { type: 'comment.deleted', payload: { id } });
        res.status(204).send();
    } catch (err) {
        logger.error({ err, commentId: id }, '[Comments] Fehler beim Löschen');
        sendError(res, 500, 'Kommentar konnte nicht gelöscht werden');
    }
});