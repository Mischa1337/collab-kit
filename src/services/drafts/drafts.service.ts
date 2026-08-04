// Privates Arbeitsmodell (Entwurf) — eine Zeile je (Session, Nutzer), Upsert.
// Importiert nur db → kein Zirkelimport.
import { db } from '../../config/db';
import { PlainModelJson } from '../../types/model';

export interface SessionDraft {
  session_id: string;
  user_id: string;
  content: string;
  model_json: unknown | null;
  base_snapshot: unknown | null;
  updated_at: string;
}

const DRAFT_COLS = 'session_id, user_id, content, model_json, base_snapshot, updated_at';

export async function upsertDraft(
  sessionId: string,
  userId: string,
  content: string,
  modelJson: PlainModelJson | null,
  baseSnapshot?: PlainModelJson | null,
): Promise<SessionDraft> {
  const model = modelJson ? JSON.stringify(modelJson) : null;
  // base_snapshot nur überschreiben, wenn explizit mitgeschickt (undefined = FE hat sich seit dem
  // letzten Save nicht neu synchronisiert → bestehenden Wert unangetastet lassen).
  if (baseSnapshot === undefined) {
    const { rows } = await db.query(
      `INSERT INTO session_drafts (session_id, user_id, content, model_json, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (session_id, user_id)
       DO UPDATE SET content = EXCLUDED.content, model_json = EXCLUDED.model_json, updated_at = NOW()
       RETURNING ${DRAFT_COLS}`,
      [sessionId, userId, content ?? '', model],
    );
    return rows[0];
  }
  const base = baseSnapshot ? JSON.stringify(baseSnapshot) : null;
  const { rows } = await db.query(
    `INSERT INTO session_drafts (session_id, user_id, content, model_json, base_snapshot, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NOW())
     ON CONFLICT (session_id, user_id)
     DO UPDATE SET content = EXCLUDED.content, model_json = EXCLUDED.model_json,
                    base_snapshot = EXCLUDED.base_snapshot, updated_at = NOW()
     RETURNING ${DRAFT_COLS}`,
    [sessionId, userId, content ?? '', model, base],
  );
  return rows[0];
}

export async function getDraft(sessionId: string, userId: string): Promise<SessionDraft | null> {
  const { rows } = await db.query(
    `SELECT ${DRAFT_COLS} FROM session_drafts WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  return rows[0] ?? null;
}

export async function deleteDraft(sessionId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'DELETE FROM session_drafts WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  return (rowCount ?? 0) > 0;
}
