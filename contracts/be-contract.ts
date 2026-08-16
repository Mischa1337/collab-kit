// ─────────────────────────────────────────────────────────────────────────────
// FE-Contract — die Schnittstelle des Backends als TypeScript-Typen.
// Stand: 20.06.2026 · Branch T-BE-Updates. SELBST-ENTHALTEN (keine Imports) →
// einfach ins FE kopieren/als Paket teilen. Nur Typen, kein Laufzeitcode.
//
// Drei Kanäle:
//   1) WS-Yjs   ws://…/sync/:sessionId?token=   → geteiltes Dokument + Cursor (Awareness)
//   2) WS-Events (gleiche Verbindung)           → Live-Signale (WSEvent unten)
//   3) REST      /api/… (Bearer-Token)          → strukturierte Daten auf Abruf
// ─────────────────────────────────────────────────────────────────────────────

// ── Rollen ───────────────────────────────────────────────────────────────────
export type SessionRole = 'owner' | 'member' | 'commentator' | 'spectator';
// owner       = alles (editieren + Peer Review + verwalten)
// member      = editieren + kommentieren + Peer Review
// commentator = kommentieren + alles sehen (KEIN Edit, KEINE Peer-Review)
// spectator   = read-only (Text + Modell), OHNE Kommentare

// ── Geteiltes Modell (M11) — liegt im selben Y.Doc neben getText('content') ────
export const MODEL = { elements: 'elements', edges: 'edges' } as const;
// ydoc.getMap('elements'): Y.Map<nodeId, Y.Map<field,value>>
// ydoc.getArray('edges'):  Y.Array<Y.Map<field,value>>
// style = MaxGraph-Style-String (z. B. "rounded=1;fillColor=#dae8fc"). MUSS beim Schreiben ans Modell
// gehängt werden, sonst gehen Farben/Formen verloren. Beliebige weitere Felder via [extra] erlaubt.
// width/height = Zellgröße — beim Resize mitgeben, sonst synct die Größenänderung nicht.
export interface ModelNode { id: string; type: string; label: string; x: number; y: number; width?: number; height?: number; style?: string; [extra: string]: unknown }
export interface ModelEdge { id: string; from: string; to: string; label?: string; style?: string; [extra: string]: unknown }
export interface PlainModel { nodes: ModelNode[]; edges: ModelEdge[] }

// ── Telepointer-Awareness-State (jeder Client setzt seinen lokal) ──────────────
export interface AwarenessState {
  user: { id: string; name: string; color: string };
  cursor?: { anchor: number; head: number };
}

// ── Schicht 2: Change-/Conflict-Awareness ─────────────────────────────────────
export type ChangeWhat =
  | 'insert' | 'delete' | 'format'                 // Text
  | 'node.added' | 'node.moved' | 'node.deleted'   // Modell-Knoten
  | 'edge.created' | 'edge.deleted'                 // Modell-Kanten
  | 'field.changed';
export interface ChangeWhere {
  target?: 'text' | 'model';
  index?: number; length?: number;                 // Text-Koordinate
  elementId?: string; edgeId?: string; field?: string; // Modell-Referenz
}
export interface ChangeRecord {
  sessionId: string;
  who: { userId: string; name?: string };
  what: ChangeWhat;
  where: ChangeWhere;
  when: string;                                    // ISO
  how?: { before?: unknown; after?: unknown };     // bei delete: entfernter Text / gelöschte Knotendaten
  why?: { kind: 'comment' | 'review'; refId: string };
}

// ── History / gespeicherte Stände (zwei Eimer) ────────────────────────────────
export type HistoryScope = 'session' | 'personal';
export type HistoryKind  = 'manual' | 'auto';
export const SESSION_MANUAL_LIMIT = 10;   // geteilter Eimer
export const PERSONAL_MANUAL_LIMIT = 5;   // persönlicher Eimer (+ 1 Auto-Slot = 6)
export interface HistoryVersion {
  id: string;
  session_id: string;
  version_number: number;
  content: string;                 // SQL-Text des Stands
  author_id: string;               // 'system' bei Auto-Slots
  name: string | null;             // benannter Stand (null bei Auto)
  scope: HistoryScope;
  kind: HistoryKind;
  model_json: PlainModel | null;   // Modell des Stands (M11) oder null = reine Textversion
  created_at: string;
}
// POST …/history. model_json optional: gesetzt → speichert DIESES Modell (z. B. eigener Entwurf);
// weggelassen → Server nimmt das Modell aus dem geteilten Live-Doc.
export interface SaveStateBody { content: string; name: string; scope?: HistoryScope; model_json?: PlainModel }
export interface BucketFullError { error: { message: string; status: 409 }; bucket: HistoryScope; limit: number; used: number }

// ── Peer Review (Multi-Reviewer + Adressierung) ───────────────────────────────
export type ReviewStatus = 'offen' | 'in_review' | 'abgeschlossen';
export type ReviewAudience = 'all' | 'selected';
export type Verdict = 'approved' | 'changes_requested' | 'rejected';
export interface ReviewFeedback { author_id: string; feedback: string; verdict: Verdict | null; created_at: string }
export interface ReviewAggregate {            // GET /api/reviews/:id
  id: string;
  session_id: string;
  requester_id: string;
  status: ReviewStatus;
  audience: ReviewAudience;
  version_id: string;
  version: { version_number: number; content: string; model_json: PlainModel | null } | null;
  assignees: string[];                        // bei audience='selected'
  feedback: ReviewFeedback[];                 // je Reviewer ein Eintrag
  comments: Comment[];
  open_comments: number;
  resolved_comments: number;
}
// GET /api/sessions/:id/reviews — Liste. Wie ReviewAggregate, aber OHNE den schweren version.content/model_json
// (stattdessen nur version_number). Für den vollen eingefrorenen Stand das Einzel-Review GET /api/reviews/:id holen.
export interface ReviewListItem {
  id: string;
  session_id: string;
  requester_id: string;
  status: ReviewStatus;
  audience: ReviewAudience;
  version_id: string;
  version_number: number | null;
  assignees: string[];
  feedback: ReviewFeedback[];
  comments: Comment[];
  open_comments: number;
  resolved_comments: number;
}
export interface CreateReviewBody { sessionId: string; versionId: string; audience?: ReviewAudience; assignees?: string[] }
export interface AddFeedbackBody { feedback: string; verdict?: Verdict }

// ── Kommentare ────────────────────────────────────────────────────────────────
export interface Comment {
  id: string;
  session_id: string;
  author_id: string;
  content: string;
  position: { line: number; character: number } | null;
  parent_id: string | null;        // Antwort (eine Ebene)
  review_id: string | null;        // ans Review gekoppelt
  node_id: string | null;          // an einen Modell-Knoten geheftet (M11) oder null
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}
export interface CreateCommentBody { content: string; position?: { line: number; character: number }; parent_id?: string; review_id?: string; node_id?: string }

// ── Privates Arbeitsmodell (Entwurf) ──────────────────────────────────────────
export interface SessionDraft { session_id: string; user_id: string; content: string; model_json: PlainModel | null; base_snapshot: PlainModel | null; updated_at: string }
// base_snapshot = geteilter Stand, auf dem der Entwurf aufbaut (Grundlage fürs Publish-Gate). PUT …/draft
// nimmt es optional (fehlt es, bleibt der zuletzt gespeicherte Wert unangetastet — reines Content-Auto-Save).
export interface PublishDraftBody { mode: 'merge' | 'replace'; confirmReplace?: boolean } // merge=Editor, replace=owner
// Publish schreibt den Entwurf DIREKT ins Live-Y.Doc (Sync verteilt an alle) + WS draft.published.
// Gate: merge → 409, wenn base_snapshot ≠ Live-Stand (erst „Gemeinsamen Stand übernehmen"). replace mit
// veralteter Basis → 409 mit { staleReplace:true, liveNodeCount, liveEdgeCount }; erst confirmReplace:true erzwingt.
export interface StaleReplaceError { error: { message: string; status: 409 }; staleReplace: true; liveNodeCount: number; liveEdgeCount: number }

// ── Aufgaben (H7) ─────────────────────────────────────────────────────────────
export type TaskStatus = 'open' | 'in_progress' | 'done';
export interface SessionTask {
  id: string; session_id: string; title: string; description: string | null;
  assignee_user_id: string | null; status: TaskStatus; created_by: string;
  created_at: string; updated_at: string;
}

// ── Benachrichtigungen ────────────────────────────────────────────────────────
export type NotificationType = 'mention' | 'comment' | 'reply' | 'review_requested' | 'review_feedback' | 'conflict';
export interface Notification { id: string; session_id: string; type: NotificationType; ref_id: string | null; read_at: string | null; created_at: string }

// ── WS-Events (Kanal 2) — JSON über dieselbe Verbindung ───────────────────────
export type WSEvent =
  | { type: 'session.role'; payload: { role: SessionRole; can_edit: boolean; active_version_id?: string | null } }
  | { type: 'change_awareness'; payload: ChangeRecord }
  | { type: 'semantic_conflict'; payload: ChangeRecord & { severity: 'info' | 'warning'; victim: { userId: string; name?: string } } }
  | { type: 'comment.created' | 'comment.updated' | 'comment.deleted'; payload: Comment | { id: string } }
  | { type: 'comment-visibility.changed'; payload: { hidden: boolean } }   // Kommentare für Reviewer aus-/einblenden
  | { type: 'review.created' | 'review.feedback_added' | 'review.closed'; payload: ReviewAggregate }
  | { type: 'review.deleted'; payload: { id: string } }
  | { type: 'task.created' | 'task.updated'; payload: SessionTask } | { type: 'task.deleted'; payload: { id: string } }
  | { type: 'chat.message'; payload: { id: string; session_id: string; user_id: string; content: string; created_at: string } }
  | { type: 'chat.deleted'; payload: { id: string } }
  | { type: 'history.restored'; payload: { version: number; by: string; name?: string | null } }
  | { type: 'history.created' | 'history.updated'; payload: { version_number: number; name: string | null; author: string } }
  | { type: 'history.active_version'; payload: { version_id: string | null } }  // sessionweite „Aktuell geladen"-Markierung
  | { type: 'draft.published'; payload: { by: string; mode: 'merge' | 'replace' } };

// ── REST-Endpunkte (Kurzreferenz) ─────────────────────────────────────────────
// Sessions:   GET /api/sessions[?active=true] · GET /api/sessions/:id · GET/POST/DELETE …/members · POST …/invite · POST …/join · POST …/join-self (→ spectator)
// Doc/Export: GET /api/sessions/:id/export            → { document:{text, model}, comments, reviews, history }
// History:    GET /api/sessions/:id/history[?scope=session|personal] → HistoryVersion[]
//             POST /api/sessions/:id/history (SaveStateBody) → 201 HistoryVersion | 409 BucketFullError
//             DELETE /api/history/:versionId · PATCH /api/history/:versionId { name }  ODER { content?, model_json? } (atomar, id bleibt)
//             POST /api/sessions/:id/history/:version/restore  (owner) → HistoryVersion (FE spielt content+model_json ein)
// Changes:    GET /api/sessions/:id/changes[?since_last_visit=true] → (ChangeRecord & {id, severity?})[]
//             PATCH /api/sessions/:id/changes/:cid/why { kind, refId }
// Reviews:    POST /api/reviews (CreateReviewBody) → 201 ReviewAggregate
//             POST /api/reviews/:id/feedback (AddFeedbackBody) → ReviewAggregate
//             POST /api/reviews/:id/close · GET /api/reviews/:id → ReviewAggregate
//             GET /api/sessions/:id/reviews → ReviewListItem[]  (mit feedback/assignees/version_number, ohne version.content)
// Comments:   POST /api/sessions/:id/comments (CreateCommentBody) · GET …/comments (spectator → 403)
//             PATCH /api/comments/:id/resolve|reopen · DELETE /api/comments/:id
// Drafts:     GET · PUT (content, model_json?, base_snapshot?) · DELETE /api/sessions/:id/draft
//             POST …/draft/publish (PublishDraftBody) → schreibt in Live-Doc + WS draft.published, { mode }; 409 bei veralteter Basis (replace: StaleReplaceError, confirmReplace erzwingt)
// Tasks:      POST/GET /api/sessions/:id/tasks · PATCH/DELETE /api/tasks/:taskId
// Chat:       POST/GET /api/sessions/:id/chat · DELETE /api/chat/:messageId (Autor/Owner → 204; WS: chat.deleted)
// Notifs:     GET /api/notifications · GET …/unread-count · POST …/read
// Me:         GET /api/me/export   (DSGVO)
