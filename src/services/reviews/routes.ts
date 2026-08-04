import { Router, Request, Response, NextFunction } from 'express';
import { sendError, assertUuid } from '../../utils/http';
import { addFeedback, createReview, getReview, getReviewMeta, isAssignee, closeReview, deleteReview, ReviewAudience, Verdict } from './review.service';
import { broadcastToSession } from '../../utils/broadcast';
import { notifyReviewCreated, notifyReviewFeedback } from '../notifications/notification.service';
import { isUuid } from '../../utils/validation';
import { db } from '../../config/db';
import { checkSessionMembership, checkSessionOwner, ensureReviewer } from '../../middleware/authorization';

export const reviewRoutes = Router();

const VALID_VERDICT: Verdict[] = ['approved', 'changes_requested', 'rejected'];

// POST /reviews — Anfrage anlegen (owner/member). versionId PFLICHT (Review nur aus gespeichertem Stand).
// audience='all' → jeder owner/member darf reviewen; 'selected' → nur die assignees.
reviewRoutes.post('/reviews', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { sessionId, versionId, audience, assignees } = req.body;
        const requesterId = req.user!.id;

        if (!assertUuid(res, sessionId, 'sessionId')) return;
        if (!versionId || typeof versionId !== 'string' || !isUuid(versionId)) {
            sendError(res, 400, 'versionId ist Pflicht (Review nur aus einem gespeicherten Stand)');
            return;
        }
        const aud: ReviewAudience = audience === 'selected' ? 'selected' : 'all';
        const list: string[] = Array.isArray(assignees) ? assignees.filter((u: unknown) => typeof u === 'string') : [];
        if (aud === 'selected' && list.length === 0) {
            sendError(res, 400, "audience='selected' erfordert mindestens einen assignee");
            return;
        }

        if (!(await ensureReviewer(requesterId, sessionId, res))) return;

        // Version muss existieren UND zu dieser Session gehören.
        const v = await db.query('SELECT session_id FROM history WHERE id = $1', [versionId]);
        if (v.rows.length === 0 || v.rows[0].session_id !== sessionId) {
            sendError(res, 400, 'versionId ungültig oder gehört zu einer anderen Session');
            return;
        }

        const created = await createReview(sessionId, requesterId, versionId, aud, list);
        const review = await getReview(created.id);
        // Flaches version_number zusätzlich zum verschachtelten version-Objekt mitgeben — die
        // Liste GET /sessions/:id/reviews liefert version_number bereits flach (Frontend prüft
        // im Template darauf, um den Vorschau-Bereich anzuzeigen). Ohne das blieb dieser Bereich
        // sowohl beim Anfragenden (optimistischer lokaler Push) als auch bei anderen (WS-Broadcast)
        // leer, bis der nächste periodische Reviews-Poll die Liste in der richtigen Form nachlud.
        const payload = { ...review, version_number: review?.version?.version_number ?? null };
        broadcastToSession(sessionId, { type: 'review.created', payload });
        void notifyReviewCreated(created, list);
        res.status(201).json(payload);
    } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23503') {
            sendError(res, 404, 'Session nicht gefunden');
            return;
        }
        next(err);
    }
});

// POST /reviews/:id/feedback — MEIN Feedback abgeben (owner/member; bei 'selected' nur Assignees). Upsert.
reviewRoutes.post('/reviews/:id/feedback', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { feedback, verdict } = req.body;
        const authorId = req.user!.id;

        if (!feedback || typeof feedback !== 'string' || feedback.trim().length === 0) {
            sendError(res, 400, 'feedback ist erforderlich');
            return;
        }
        if (verdict !== undefined && verdict !== null && !VALID_VERDICT.includes(verdict)) {
            sendError(res, 400, "verdict muss 'approved', 'changes_requested' oder 'rejected' sein");
            return;
        }

        const meta = await getReviewMeta(id);
        if (!meta) {
            sendError(res, 404, 'Review nicht gefunden');
            return;
        }
        if (!(await ensureReviewer(authorId, meta.session_id, res))) return;
        if (meta.audience === 'selected' && !(await isAssignee(id, authorId))) {
            sendError(res, 403, 'Du wurdest für dieses Review nicht angefragt');
            return;
        }

        const review = await addFeedback(id, authorId, feedback, verdict ?? null);
        broadcastToSession(meta.session_id, { type: 'review.feedback_added', payload: review });
        void notifyReviewFeedback({ id, session_id: meta.session_id, requester_id: meta.requester_id }, authorId);
        res.json(review);
    } catch (err) {
        next(err);
    }
});

// POST /reviews/:id/close — abschließen: jeder Reviewer (owner/member) AUßER dem Anfrager selbst.
reviewRoutes.post('/reviews/:id/close', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const meta = await getReviewMeta(id);
        if (!meta) {
            sendError(res, 404, 'Review nicht gefunden');
            return;
        }
        // Reviewer (owner/member) dürfen abschließen — der Anfrager NICHT sein eigenes Review.
        if (!(await ensureReviewer(req.user!.id, meta.session_id, res))) return;
        if (meta.requester_id === req.user!.id) {
            sendError(res, 403, 'Der Anfrager darf sein eigenes Review nicht abschließen');
            return;
        }
        const review = await closeReview(id);
        broadcastToSession(meta.session_id, { type: 'review.closed', payload: review });
        res.json(review);
    } catch (err) {
        next(err);
    }
});

// DELETE /reviews/:id — Anfrage löschen (versehentlich gesendet). Anfrager nur solange 'offen'
// (noch kein Feedback), Owner jederzeit. review_assignees/feedback gehen per CASCADE mit.
reviewRoutes.delete('/reviews/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const meta = await getReviewMeta(id);
        if (!meta) {
            sendError(res, 404, 'Review nicht gefunden');
            return;
        }
        const isOwner = await checkSessionOwner(req.user!.id, meta.session_id);
        const isRequester = meta.requester_id === req.user!.id;
        if (!isOwner && !(isRequester && meta.status === 'offen')) {
            sendError(res, 403, 'Nur der Anfrager (solange offen) oder ein Owner darf die Anfrage löschen');
            return;
        }
        await deleteReview(id);
        broadcastToSession(meta.session_id, { type: 'review.deleted', payload: { id } });
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

reviewRoutes.get('/reviews/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const meta = await getReviewMeta(id);
        if (!meta) {
            sendError(res, 404, 'Review nicht gefunden');
            return;
        }
        if (!await checkSessionMembership(req.user!.id, meta.session_id)) {
            sendError(res, 403, 'Kein Mitglied dieser Session');
            return;
        }
        res.json(await getReview(id));
    } catch (err) {
        next(err);
    }
});
