import { db } from '../../config/db';
import { getReviewComments } from '../comments/comments.repository';

export type ReviewAudience = 'all' | 'selected';
export type Verdict = 'approved' | 'changes_requested' | 'rejected';

// Schlanke Metadaten (ohne Aggregation) — für Rechte-/Existenzprüfungen.
export async function getReviewMeta(reviewId: string) {
    const { rows } = await db.query(
        'SELECT id, session_id, requester_id, status, version_id, audience FROM reviews WHERE id = $1',
        [reviewId],
    );
    return rows[0] ?? null;
}

export async function createReview(
    sessionId: string,
    requesterId: string,
    versionId: string,
    audience: ReviewAudience,
    assignees: string[],
) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query(
            `INSERT INTO reviews (session_id, requester_id, status, version_id, audience)
             VALUES ($1, $2, 'offen', $3, $4)
             RETURNING id, session_id, requester_id, status, version_id, audience, created_at`,
            [sessionId, requesterId, versionId, audience],
        );
        const review = r.rows[0];
        if (audience === 'selected') {
            for (const u of assignees) {
                await client.query(
                    'INSERT INTO review_assignees (review_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [review.id, u],
                );
            }
        }
        await client.query('COMMIT');
        return review;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function getAssignees(reviewId: string): Promise<string[]> {
    const { rows } = await db.query('SELECT user_id FROM review_assignees WHERE review_id = $1', [reviewId]);
    return rows.map((r: { user_id: string }) => r.user_id);
}

export async function isAssignee(reviewId: string, userId: string): Promise<boolean> {
    const { rows } = await db.query(
        'SELECT 1 FROM review_assignees WHERE review_id = $1 AND user_id = $2',
        [reviewId, userId],
    );
    return rows.length > 0;
}

// ── Batch-Lader (kein N+1) — für die Reviews-LISTE: alle Feedbacks/Assignees mehrerer Reviews
//    in EINER Abfrage holen und nach review_id gruppieren. ───────────────────────────────────
export interface FeedbackEntry { author_id: string; feedback: string; verdict: Verdict | null; created_at: unknown }

export async function getFeedbackByReviewIds(reviewIds: string[]): Promise<Map<string, FeedbackEntry[]>> {
    const map = new Map<string, FeedbackEntry[]>();
    if (reviewIds.length === 0) return map;
    const { rows } = await db.query(
        'SELECT review_id, author_id, feedback, verdict, created_at FROM review_feedback WHERE review_id = ANY($1) ORDER BY created_at ASC',
        [reviewIds],
    );
    for (const r of rows as Array<{ review_id: string } & FeedbackEntry>) {
        const list = map.get(r.review_id) ?? [];
        list.push({ author_id: r.author_id, feedback: r.feedback, verdict: r.verdict, created_at: r.created_at });
        map.set(r.review_id, list);
    }
    return map;
}

export async function getAssigneesByReviewIds(reviewIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (reviewIds.length === 0) return map;
    const { rows } = await db.query(
        'SELECT review_id, user_id FROM review_assignees WHERE review_id = ANY($1)',
        [reviewIds],
    );
    for (const r of rows as Array<{ review_id: string; user_id: string }>) {
        const list = map.get(r.review_id) ?? [];
        list.push(r.user_id);
        map.set(r.review_id, list);
    }
    return map;
}

// Status ableiten: offen (kein Feedback) → in_review (≥1) → abgeschlossen
// (bei 'selected', wenn alle Assignees abgegeben haben; bei 'all' nur über closeReview).
async function recomputeStatus(reviewId: string): Promise<void> {
    const meta = await getReviewMeta(reviewId);
    if (!meta) return;
    const fb = await db.query('SELECT count(*)::int AS c FROM review_feedback WHERE review_id = $1', [reviewId]);
    const count = fb.rows[0].c as number;
    let status = 'offen';
    if (count > 0) {
        status = 'in_review';
        if (meta.audience === 'selected') {
            const as = await db.query('SELECT count(*)::int AS c FROM review_assignees WHERE review_id = $1', [reviewId]);
            const total = as.rows[0].c as number;
            if (total > 0 && count >= total) status = 'abgeschlossen';
        }
    }
    await db.query('UPDATE reviews SET status = $2 WHERE id = $1', [reviewId, status]);
}

// Feedback eines Reviewers (Upsert: ein Abschluss-Feedback je Reviewer), dann Status neu ableiten.
export async function addFeedback(reviewId: string, authorId: string, feedback: string, verdict?: Verdict | null) {
    await db.query(
        `INSERT INTO review_feedback (review_id, author_id, feedback, verdict)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (review_id, author_id)
         DO UPDATE SET feedback = EXCLUDED.feedback, verdict = EXCLUDED.verdict, created_at = NOW()`,
        [reviewId, authorId, feedback.trim(), verdict ?? null],
    );
    await recomputeStatus(reviewId);
    return getReview(reviewId);
}

export async function closeReview(reviewId: string) {
    const { rowCount } = await db.query(`UPDATE reviews SET status = 'abgeschlossen' WHERE id = $1`, [reviewId]);
    return (rowCount ?? 0) > 0 ? getReview(reviewId) : null;
}

// Review-Anfrage ganz löschen (z.B. versehentlich gesendet). review_assignees + review_feedback
// gehen per ON DELETE CASCADE mit; an das Review gehängte Kommentare werden zu allgemeinen
// Kommentaren (comments.review_id ist ON DELETE SET NULL).
export async function deleteReview(reviewId: string): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM reviews WHERE id = $1', [reviewId]);
    return (rowCount ?? 0) > 0;
}

// Aggregiert: Review + eingefrorene Version (Text+Modell) + Empfänger + Feedback-Liste + Kommentare.
export async function getReview(reviewId: string) {
    const r = await db.query(
        `SELECT r.id, r.session_id, r.requester_id, r.status, r.version_id, r.audience, r.created_at,
                h.version_number, h.content, h.model_json
         FROM reviews r
         LEFT JOIN history h ON h.id = r.version_id
         WHERE r.id = $1`,
        [reviewId],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];

    const version = row.version_id
        ? { version_number: Number(row.version_number), content: row.content, model_json: row.model_json ?? null }
        : null;
    const assignees = await getAssignees(reviewId);
    const fb = await db.query(
        'SELECT author_id, feedback, verdict, created_at FROM review_feedback WHERE review_id = $1 ORDER BY created_at ASC',
        [reviewId],
    );
    const { comments, open_comments, resolved_comments } = await getReviewComments(reviewId);

    return {
        id: row.id,
        session_id: row.session_id,
        requester_id: row.requester_id,
        status: row.status,
        version_id: row.version_id,
        audience: row.audience,
        created_at: row.created_at,
        version,
        assignees,
        feedback: fb.rows,
        comments,
        open_comments,
        resolved_comments,
    };
}
