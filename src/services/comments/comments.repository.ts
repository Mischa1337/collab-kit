// Kommentar-Datenzugriff — eine Quelle der Wahrheit für Spaltenliste und Aggregation.
// Behebt R1 (inkonsistente Spalten), R2 (duplizierte Zähllogik) und R5 (Cross-Service-DB-Zugriff):
// reviews- und sessions-Service laden Kommentare über diese Funktionen statt mit eigenem SQL.
import { db } from '../../config/db';

// Gemeinsame Spaltenliste — hält ALLE Kommentar-SELECTs/RETURNINGs konsistent
// (inkl. der M18-Felder parent_id/resolved_by und der M23-Spalte review_id).
export const COMMENT_COLS =
  'id, session_id, author_id, content, position, parent_id, review_id, node_id, resolved_at, resolved_by, created_at';

interface ReviewComments {
  comments: unknown[];
  open_comments: number;
  resolved_comments: number;
}

function emptyBucket(): ReviewComments {
  return { comments: [], open_comments: 0, resolved_comments: 0 };
}

// Kommentare EINES Reviews + Zähler offen/aufgelöst (M23-Aggregation).
export async function getReviewComments(reviewId: string): Promise<ReviewComments> {
  const result = await db.query(
    `SELECT ${COMMENT_COLS} FROM comments WHERE review_id = $1 ORDER BY created_at ASC`,
    [reviewId],
  );
  const bucket = emptyBucket();
  for (const row of result.rows as { resolved_at: string | null }[]) {
    bucket.comments.push(row);
    if (row.resolved_at) bucket.resolved_comments++;
    else bucket.open_comments++;
  }
  return bucket;
}

// Kommentare MEHRERER Reviews in EINER Abfrage (behebt R3 — kein N+1).
// Liefert pro Review-ID ein Bucket; Reviews ohne Kommentare bekommen ein leeres Bucket.
export async function getReviewCommentsBatch(
  reviewIds: string[],
): Promise<Map<string, ReviewComments>> {
  const byReview = new Map<string, ReviewComments>();
  for (const id of reviewIds) byReview.set(id, emptyBucket());
  if (reviewIds.length === 0) return byReview;

  const result = await db.query(
    `SELECT ${COMMENT_COLS} FROM comments WHERE review_id = ANY($1) ORDER BY created_at ASC`,
    [reviewIds],
  );
  for (const row of result.rows as { review_id: string; resolved_at: string | null }[]) {
    const bucket = byReview.get(row.review_id);
    if (!bucket) continue;
    bucket.comments.push(row);
    if (row.resolved_at) bucket.resolved_comments++;
    else bucket.open_comments++;
  }
  return byReview;
}
