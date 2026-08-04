// Punkt 3 — Nachlesbarer Change-Feed.
// Persistiert die (bereits gedrosselten) Schicht-2-Events zusätzlich zum Broadcast und
// liefert sie chronologisch zum Nachladen. Importiert nur db/Typen → kein Zirkelimport.
import { db } from '../../config/db';
import { logger } from '../../config/logger';
import { AwarenessEvent, ChangeRecord } from '../collaboration/awareness.types';

export type ChangeEntry = ChangeRecord & { id?: string; severity?: 'info' | 'warning' };

/**
 * Schreibt ein Awareness-Event (change_awareness | semantic_conflict) ins change_log.
 * Defensiv: wirft nie (darf den Broadcast/Sync nie stören).
 */
export async function appendChangeLog(sessionId: string, event: AwarenessEvent): Promise<void> {
  try {
    const p = event.payload;
    const severity = event.type === 'semantic_conflict' ? event.payload.severity : null;
    const w = p.where;
    const isModel = w.target === 'model';
    await db.query(
      `INSERT INTO change_log
         (session_id, who_user_id, who_name, what, target, where_index, where_length, where_element, where_edge, where_field, severity, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, NOW()))`,
      [
        sessionId, p.who.userId, p.who.name ?? null, p.what,
        isModel ? 'model' : 'text',
        isModel ? null : (w.index ?? 0),
        isModel ? null : (w.length ?? 0),
        w.elementId ?? null, w.edgeId ?? null, w.field ?? null,
        severity, p.when ?? null,
      ],
    );
  } catch (err) {
    logger.error({ err, sessionId }, '[ChangeLog] appendChangeLog Fehler (ignoriert)');
  }
}

interface ChangeRow {
  id: string;
  who_user_id: string;
  who_name: string | null;
  what: ChangeRecord['what'];
  target: 'text' | 'model' | null;
  where_index: number | null;
  where_length: number | null;
  where_element: string | null;
  where_edge: string | null;
  where_field: string | null;
  severity: 'info' | 'warning' | null;
  why_kind: 'comment' | 'review' | null;
  why_ref: string | null;
  created_at: Date | string;
}

const CHANGE_COLS = 'id, who_user_id, who_name, what, target, where_index, where_length, where_element, where_edge, where_field, severity, why_kind, why_ref, created_at';

function toEntry(sessionId: string, r: ChangeRow): ChangeEntry {
  const entry: ChangeEntry = {
    id: r.id,
    sessionId,
    who: { userId: r.who_user_id, name: r.who_name ?? undefined },
    what: r.what,
    // Modell-Eintrag → IDs; sonst Text-Koordinate (abwärtskompatibel).
    where: r.target === 'model'
      ? { target: 'model', elementId: r.where_element ?? undefined, edgeId: r.where_edge ?? undefined, field: r.where_field ?? undefined }
      : { index: r.where_index ?? 0, length: r.where_length ?? 0 },
    when: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
  if (r.severity) entry.severity = r.severity;
  if (r.why_kind && r.why_ref) entry.why = { kind: r.why_kind, refId: r.why_ref };
  return entry;
}

/** Änderungen einer Session, neueste zuerst; optional ab Zeitpunkt `since` (ISO). */
export async function getChanges(
  sessionId: string,
  opts: { since?: string; limit?: number; offset?: number } = {},
): Promise<ChangeEntry[]> {
  const params: unknown[] = [sessionId];
  let where = 'session_id = $1';
  if (opts.since) {
    params.push(opts.since);
    where += ` AND created_at > $${params.length}::timestamptz`;
  }
  params.push(opts.limit ?? 50);
  const limIdx = params.length;
  params.push(opts.offset ?? 0);
  const offIdx = params.length;
  const { rows } = await db.query(
    `SELECT ${CHANGE_COLS}
     FROM change_log WHERE ${where}
     ORDER BY created_at DESC LIMIT $${limIdx} OFFSET $${offIdx}`,
    params,
  );
  return rows.map((r: ChangeRow) => toEntry(sessionId, r));
}

// A3: eine Änderung/einen Konflikt mit einer Begründungsquelle (Kommentar/Review) verknüpfen.
export async function setChangeWhy(
  sessionId: string, changeId: string, kind: 'comment' | 'review', refId: string,
): Promise<ChangeEntry | null> {
  const { rows } = await db.query(
    `UPDATE change_log SET why_kind = $3, why_ref = $4
     WHERE id = $1 AND session_id = $2
     RETURNING ${CHANGE_COLS}`,
    [changeId, sessionId, kind, refId],
  );
  return rows[0] ? toEntry(sessionId, rows[0]) : null;
}

/** Letzter Besuchszeitpunkt eines Nutzers (für ?since_last_visit), nutzt das vorhandene session_views. */
export async function getLastVisit(sessionId: string, userId: string): Promise<string | null> {
  const { rows } = await db.query(
    'SELECT last_seen_at FROM session_views WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  const v = rows[0]?.last_seen_at as Date | string | undefined;
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}
