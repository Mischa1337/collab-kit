import { db } from '../../config/db';
import { PlainModelJson } from '../../types/model';
import { settings } from '../../config/settings';

export type HistoryScope = 'session' | 'personal';
export type HistoryKind = 'manual' | 'auto';

// Eimer-Limits (nur MANUELLE Stände zählen; Auto-Slots sind ausgenommen) — Defaults 10 / 5.
export const SESSION_MANUAL_LIMIT = settings.history.sessionLimit;   // geteilter Verlauf
export const PERSONAL_MANUAL_LIMIT = settings.history.personalLimit; // persönlicher Verlauf je Nutzer (+ 1 Auto-Slot)

// REST-Antwortform: snake_case (einheitlich mit comments/reviews/sessions/participants).
type Version = {
    id: string;
    session_id: string;
    version_number: number;
    content: string;
    author_id: string;
    name: string | null;
    scope: HistoryScope;
    kind: HistoryKind;
    model_json: unknown | null;   // {nodes, edges} (M11) oder null = reine Textversion
    created_at: Date;
    updated_at: Date;
};

const VERSION_COLS = 'id, session_id, version_number, content, author_id, name, scope, kind, model_json, created_at, updated_at';

function rowToVersion(row: Record<string, unknown>): Version {
    return {
        id:             String(row.id),
        session_id:     String(row.session_id),
        version_number: Number(row.version_number),
        content:        String(row.content),
        author_id:      String(row.author_id),
        name:           row.name != null ? String(row.name) : null,
        scope:          (row.scope as HistoryScope) ?? 'session',
        kind:           (row.kind as HistoryKind) ?? 'manual',
        model_json:     row.model_json ?? null,
        created_at:     row.created_at as Date,
        updated_at:     row.updated_at as Date,
    };
}

interface CreateOpts {
    name?: string | null;
    scope?: HistoryScope;
    kind?: HistoryKind;
    modelJson?: PlainModelJson | null;
}

// Modell-JSON für die DB: nur speichern, wenn es überhaupt Inhalt hat (sonst NULL = Textversion).
function modelParam(modelJson?: PlainModelJson | null): string | null {
    if (!modelJson) return null;
    if ((modelJson.nodes?.length ?? 0) === 0 && (modelJson.edges?.length ?? 0) === 0) return null;
    return JSON.stringify(modelJson);
}

export async function createVersion(
    sessionId: string,
    content: string,
    authorId: string,
    opts: CreateOpts = {}
): Promise<Version> {
    // Leere Versionen bringen keinen Mehrwert und verschmutzen die History.
    // trim(): Versionen die nur Whitespace enthalten gelten ebenfalls als leer.
    if (content.trim().length === 0) {
        throw new Error('Leere Versionen werden nicht gespeichert');
    }

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        // Advisory lock per session: verhindert gleichzeitige Inserts mit derselben version_number
        // 64-bit Lock statt 32-bit: hashtext() gibt nur 32-bit zurück, ::bigint erweitert auf 64-bit
        // → Kollisionswahrscheinlichkeit sinkt von ~1:4Mrd auf ~1:18Trillion
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [sessionId]);

        const result = await client.query(
            `INSERT INTO history (session_id, version_number, content, author_id, name, scope, kind, model_json)
             VALUES (
                 $1,
                 (SELECT COALESCE(MAX(version_number), 0) + 1 FROM history WHERE session_id = $1),
                 $2, $3, $4, $5, $6, $7::jsonb
             )
             RETURNING ${VERSION_COLS}`,
            [sessionId, content, authorId, opts.name ?? null, opts.scope ?? 'session', opts.kind ?? 'manual', modelParam(opts.modelJson)]
        );

        await client.query('COMMIT');
        return rowToVersion(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function getHistory(
    sessionId: string,
    limit = 50,
    offset = 0
): Promise<Version[]> {
    const result = await db.query(
        `SELECT ${VERSION_COLS}
         FROM history
         WHERE session_id = $1
         ORDER BY version_number ASC
         LIMIT $2 OFFSET $3`,
        [sessionId, limit, offset]
    );
    return result.rows.map(rowToVersion);
}

// Liste eines Eimers; bei 'personal' auf den eigenen Autor gefiltert.
export async function listByScope(
    sessionId: string,
    scope: HistoryScope,
    authorId?: string
): Promise<Version[]> {
    const params: unknown[] = [sessionId, scope];
    let where = 'session_id = $1 AND scope = $2';
    if (authorId) { params.push(authorId); where += ` AND author_id = $${params.length}`; }
    const result = await db.query(
        `SELECT ${VERSION_COLS} FROM history WHERE ${where} ORDER BY created_at DESC`,
        params
    );
    return result.rows.map(rowToVersion);
}

// Zählt die MANUELLEN Stände eines Eimers (für die „Speicher voll"-Prüfung). Auto-Slots zählen nicht.
export async function countManual(
    sessionId: string,
    scope: HistoryScope,
    authorId?: string
): Promise<number> {
    const params: unknown[] = [sessionId, scope];
    let where = "session_id = $1 AND scope = $2 AND kind = 'manual'";
    if (authorId) { params.push(authorId); where += ` AND author_id = $${params.length}`; }
    const { rows } = await db.query(`SELECT count(*) FROM history WHERE ${where}`, params);
    return Number(rows[0].count);
}

export async function getVersion(
    sessionId: string,
    versionNumber: number
): Promise<Version | undefined> {
    const result = await db.query(
        `SELECT ${VERSION_COLS}
         FROM history
         WHERE session_id = $1 AND version_number = $2`,
        [sessionId, versionNumber]
    );
    if (result.rows.length === 0) return undefined;
    return rowToVersion(result.rows[0]);
}

// Einen Stand über seine UUID laden (für gezieltes Löschen/Umbenennen).
export async function getVersionById(id: string): Promise<Version | undefined> {
    const result = await db.query(`SELECT ${VERSION_COLS} FROM history WHERE id = $1`, [id]);
    return result.rows[0] ? rowToVersion(result.rows[0]) : undefined;
}

export async function deleteVersionById(id: string): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM history WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
}

export async function renameVersion(id: string, name: string): Promise<Version | undefined> {
    const { rows } = await db.query(
        `UPDATE history SET name = $2 WHERE id = $1 RETURNING ${VERSION_COLS}`,
        [id, name]
    );
    return rows[0] ? rowToVersion(rows[0]) : undefined;
}

export interface UpdateVersionOpts {
    name?: string;
    content?: string;
    modelJson?: PlainModelJson | null;
    // Unterscheidet "model_json nicht mitgeschickt" (Feld unverändert lassen) von
    // "model_json bewusst auf null gesetzt" (Stand wird zur reinen Textversion).
    hasModelJson: boolean;
}

// Echtes In-Place-Update eines bestehenden Stands: dieselbe id/version_number bleiben erhalten,
// eine einzige atomare UPDATE-Query — kein Delete+Insert. Schlägt die Query fehl, bleibt die
// alte Zeile unverändert (kein Datenverlust). Ersetzt den Delete+Recreate-Workaround im Frontend.
export async function updateVersion(id: string, opts: UpdateVersionOpts): Promise<Version | undefined> {
    const model = opts.hasModelJson ? modelParam(opts.modelJson) : null;
    const { rows } = await db.query(
        `UPDATE history
         SET name       = COALESCE($2, name),
             content    = COALESCE($3, content),
             model_json = CASE WHEN $4 THEN $5::jsonb ELSE model_json END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING ${VERSION_COLS}`,
        [id, opts.name ?? null, opts.content ?? null, opts.hasModelJson, model]
    );
    return rows[0] ? rowToVersion(rows[0]) : undefined;
}

// Auto-Stand „letzter Stand" upserten: genau EINER je (session, scope, author).
// Ersetzt den vorherigen Auto-Stand statt anzuhäufen. Leere Inhalte werden übersprungen.
export async function upsertAutoVersion(
    sessionId: string,
    authorId: string,
    content: string,
    scope: HistoryScope,
    modelJson?: PlainModelJson | null,
    name?: string | null
): Promise<void> {
    const model = modelParam(modelJson);
    // Nichts zu sichern, wenn weder Text noch Modell Inhalt haben.
    if (content.trim().length === 0 && model === null) return;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [sessionId]);
        await client.query(
            `DELETE FROM history WHERE session_id = $1 AND scope = $2 AND kind = 'auto' AND author_id = $3`,
            [sessionId, scope, authorId]
        );
        await client.query(
            `INSERT INTO history (session_id, version_number, content, author_id, name, scope, kind, model_json)
             VALUES (
                 $1,
                 (SELECT COALESCE(MAX(version_number), 0) + 1 FROM history WHERE session_id = $1),
                 $2, $3, $4, $5, 'auto', $6::jsonb
             )`,
            [sessionId, content, authorId, name ?? null, scope, model]
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
