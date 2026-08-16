// WP0 — Verträge für Change- & Conflict-Awareness (Schicht 2) + Telepointer.
// Diese Typen sind die gemeinsame Schnittstelle zwischen Backend-Erkennung und Frontend (Schicht 3).
// Konzept: semantische Konflikterkennung als eigene Schicht ueber dem CRDT (Schicht 2).

// Art der Änderung — Text (insert/delete/format) ODER Modell (Knoten/Kanten/Feld, M11).
export type ChangeWhat =
  | 'insert' | 'delete' | 'format'                 // Text  (Y.Text)
  | 'node.added' | 'node.moved' | 'node.deleted'   // Modell-Knoten (Y.Map 'elements')
  | 'edge.created' | 'edge.deleted'                 // Modell-Kanten (Y.Map 'edges', ID-adressiert)
  | 'field.changed';                               // Feld innerhalb eines Knotens

// where — Adressierung der betroffenen Stelle. Bei Text: index/length. Bei Modell: target='model'
// + elementId/edgeId/field. index/length sind dann nicht gesetzt (das FE verzweigt nach `target`).
export interface ChangeWhere {
  target?: 'text' | 'model';
  index?: number;
  length?: number;
  elementId?: string;
  edgeId?: string;
  field?: string;
}

// ── Die 6 Fragen der Change Awareness (Tam & Greenberg 2006) ──────────────────
export interface ChangeRecord {
  sessionId: string;
  /** who — wer die Änderung ausgelöst hat */
  who: { userId: string; name?: string };
  /** what — Art der Änderung (Text oder Modell) */
  what: ChangeWhat;
  /** where — Text-Koordinate (index/length) oder Modell-Referenz (target='model' + IDs) */
  where: ChangeWhere;
  /** when — ISO-Zeitstempel */
  when: string;
  /** how — Diff von → nach (optional; bei delete = entfernter Text bzw. gelöschte Knotendaten) */
  how?: { before?: unknown; after?: unknown };
  /** why — verknüpfte Begründung; NUR menschlich (Kommentar/Review), sonst undefined */
  why?: { kind: 'comment' | 'review'; refId: string };
}

// ── WS-Event: passiver Feed (jede aggregierte Änderung — „seit du weg warst") ─
export interface ChangeAwarenessEvent {
  type: 'change_awareness';
  payload: ChangeRecord;
}

// ── WS-Event: aktives Flag (erkannte semantische Kollision, Edit-vs-Delete) ────
export interface SemanticConflictEvent {
  type: 'semantic_conflict';
  payload: ChangeRecord & {
    severity: 'info' | 'warning';
    /** victim — Autor des überschriebenen/gelöschten Inhalts (Nutzer A) */
    victim: { userId: string; name?: string };
  };
}

export type AwarenessEvent = ChangeAwarenessEvent | SemanticConflictEvent;

// Payload eines semantischen Konflikts — vorher doppelt in changeTracker/modelTracker definiert.
export type ConflictPayload = Extract<AwarenessEvent, { type: 'semantic_conflict' }>['payload'];

// ── Telepointer-Awareness-State (y-protocols/awareness) ───────────────────────
// Form, die jeder Client lokal setzt und die anderen rendern.
export interface AwarenessState {
  user: { id: string; name: string; color: string };
  /** Cursor/Selektion als Y.RelativePosition (serialisiert), damit sie Edits übersteht */
  cursor?: { anchor: number; head: number };
}

// ── Event-Typ-Konstanten (eine Quelle der Wahrheit) ───────────────────────────
export const AWARENESS_EVENT = {
  change: 'change_awareness',
  conflict: 'semantic_conflict',
} as const;
