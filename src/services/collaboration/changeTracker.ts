// Change/Conflict-Awareness (Schicht 2): beobachtet Yjs-Textänderungen + Awareness und erzeugt
// Awareness-Events nach den Regeln A (proaktiver Overlap), B (Edit-vs-Delete), C (gleiche SQL-Anweisung).
// ADVISORY — ändert den Merge nie.
// Die Erkennung liegt bewusst UEBER dem CRDT und meldet nur, was der Merge nicht erfasst.
//
// Die Adapter (onTextChange/onAwareness) GEBEN Events ZURÜCK (kein controller-Import → kein Zirkelimport);
// die reinen Regel-Funktionen (evaluateDeletion/evaluateOverlap/evaluateStatementConflict) sind isoliert testbar.
import type * as Y from 'yjs';
import { ChangeRecord, AwarenessEvent, AWARENESS_EVENT, ConflictPayload } from './awareness.types';
import { settings } from '../../config/settings';

const FRESH_MS = settings.awareness.freshMs;
const FEED_THROTTLE_MS = settings.awareness.feedThrottleMs;
const OVERLAP_THROTTLE_MS = settings.awareness.overlapMs;

export interface User { userId: string; name?: string }

interface SessionState {
  recent: Map<number, number>; // Yjs-ClientID des Autors → letzter Schreibzeitpunkt (ms) — „frisch"
  lastFeed: number;
  lastOverlap: number;
  stmtEditors: Map<number, { userId: string; at: number }>; // SQL-Anweisungs-Index → letzter Bearbeiter (Regel C)
  lastText: string; // Dokumentstand vor der aktuellen Änderung — für how.before (gelöschter Text)
}
const sessions = new Map<string, SessionState>();
function state(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { recent: new Map(), lastFeed: 0, lastOverlap: 0, stmtEditors: new Map(), lastText: '' };
    sessions.set(sessionId, s);
  }
  return s;
}

// Kontext, den der Aufrufer (controller) aus conn→userId und der Awareness liefert.
export interface ChangeContext {
  actorUserId: string | null;            // wer diese Änderung ausgelöst hat (aus tr.origin/conn)
  authorOf: (yjsClientId: number) => User; // Autor-Auflösung (Awareness → echter Nutzer, sonst ClientID)
  isActive?: (userId: string) => boolean;  // A1: ist dieser Nutzer gerade verbunden? (M22/lokale Präsenz)
}

// ── Regel B (rein): Edit-vs-Delete — jemand löscht *frischen* Inhalt eines *anderen*. ─────────
export interface Deletion { authorClientId: number; length: number; index: number; text: string }
export function evaluateDeletion(input: {
  sessionId: string;
  actorUserId: string | null;
  deletions: Deletion[];
  authorOf: (c: number) => User;
  recent: Map<number, number>;
  now: number;
  freshMs?: number;
  isActive?: (userId: string) => boolean; // A1: Opfer muss (noch) aktiv sein
}): ConflictPayload | null {
  const fresh = input.freshMs ?? FRESH_MS;
  for (const d of input.deletions) {
    const victim = input.authorOf(d.authorClientId);
    if (input.actorUserId && victim.userId === input.actorUserId) continue; // eigene Löschung
    const last = input.recent.get(d.authorClientId);
    if (last === undefined || input.now - last > fresh) continue; // nicht frisch ⇒ nicht aktiv
    if (input.isActive && !input.isActive(victim.userId)) continue; // A1: Opfer nicht (mehr) verbunden → kein Live-Flag
    return {
      sessionId: input.sessionId,
      who: { userId: input.actorUserId ?? 'unbekannt' },
      what: 'delete',
      where: { index: d.index, length: d.length },
      how: { before: d.text, after: '' },
      when: new Date(input.now).toISOString(),
      severity: 'warning',
      victim,
    };
  }
  return null;
}

// ── Regel A (rein): proaktiver Overlap zweier Cursor-Bereiche verschiedener Nutzer. ──────────
export function evaluateOverlap(
  a: { userId: string; name?: string; range: [number, number] },
  b: { userId: string; name?: string; range: [number, number] },
  sessionId: string,
  now: number,
): ConflictPayload | null {
  if (a.userId === b.userId) return null;
  const lo = Math.max(Math.min(...a.range), Math.min(...b.range));
  const hi = Math.min(Math.max(...a.range), Math.max(...b.range));
  if (lo > hi) return null; // kein Overlap
  return {
    sessionId,
    who: { userId: b.userId, name: b.name },
    what: 'format',
    where: { index: lo, length: hi - lo },
    when: new Date(now).toISOString(),
    severity: 'info',
    victim: { userId: a.userId, name: a.name },
  };
}

// ── Regel C (rein): gleichzeitige Änderung *derselben SQL-Anweisung* durch verschiedene Nutzer. ─
export function evaluateStatementConflict(input: {
  sessionId: string;
  stmtIndex: number;
  editorUserId: string;
  previous: { userId: string; at: number } | undefined;
  now: number;
  freshMs?: number;
  isActive?: (userId: string) => boolean; // A1: vorheriger Bearbeiter muss (noch) aktiv sein
}): ConflictPayload | null {
  const fresh = input.freshMs ?? FRESH_MS;
  const p = input.previous;
  if (!p || p.userId === input.editorUserId || input.now - p.at > fresh) return null;
  if (input.isActive && !input.isActive(p.userId)) return null; // A1: vorheriger Bearbeiter nicht (mehr) verbunden
  return {
    sessionId: input.sessionId,
    who: { userId: input.editorUserId },
    what: 'format',
    where: { index: input.stmtIndex, length: 0 },
    when: new Date(input.now).toISOString(),
    severity: 'info',
    victim: { userId: p.userId },
  };
}

// ── Yjs-Hilfen ────────────────────────────────────────────────────────────────
// In welcher „Anweisung" (durch ; oder Zeilenumbruch getrennt) liegt charIndex?
export function statementIndexAt(text: string, charIndex: number): number {
  return text.slice(0, Math.max(0, charIndex)).split(/[;\n]/).length - 1;
}

interface ExtractResult { deletions: Deletion[]; primaryIndex: number; isInsert: boolean }
function extractFromTextEvent(event: Y.YTextEvent, prevText: string): ExtractResult {
  // Delta gegen den Vorzustand walken: `index` = Position im NEUEN Doc (für primaryIndex),
  // `prevPos` = Position im alten Text. `removed` sammelt den EXAKT entfernten Text (A5-Robustheit:
  // auch bei gemischten Insert+Delete-/Mehr-Op-Transaktionen korrekt, statt nur eines groben slice).
  let index = 0;
  let prevPos = 0;
  let primaryIndex = 0;
  let found = false;
  let isInsert = false;
  let removed = '';
  for (const op of event.changes.delta) {
    if (op.retain != null) {
      index += op.retain;
      prevPos += op.retain;
    } else if (op.insert != null) {
      if (!found) { primaryIndex = index; found = true; isInsert = true; }
      index += typeof op.insert === 'string' ? op.insert.length : 1;
    } else if (op.delete != null) {
      if (!found) { primaryIndex = index; found = true; }
      removed += prevText.slice(prevPos, prevPos + op.delete);
      prevPos += op.delete;
    }
  }

  // Autor + Umfang der gelöschten Inhalte aus dem DeleteSet der Transaktion.
  // (event.changes.deleted ist bei .observe() leer; das DeleteSet trägt die ClientID des *Autors*
  //  der gelöschten Items — genau das Opfer, das Regel B braucht.) Der gelöschte Text (`removed`)
  //  stammt exakt aus dem Dokumentstand vor der Änderung.
  const deletions: Deletion[] = [];
  const ds = (event.transaction as unknown as { deleteSet?: { clients?: Map<number, Array<{ len: number }>> } }).deleteSet;
  ds?.clients?.forEach((ranges, client) => {
    let len = 0;
    ranges.forEach((r) => { len += r.len; });
    if (len > 0) {
      deletions.push({ authorClientId: client, length: len, index: primaryIndex, text: removed });
    }
  });
  return { deletions, primaryIndex, isInsert };
}

// ── Adapter B+C: an ydoc.getText('content').observe(...) hängen. Gibt Events zurück; wirft nie. ─
export function onTextChange(sessionId: string, event: Y.YTextEvent, ctx: ChangeContext, now: number = Date.now()): AwarenessEvent[] {
  const events: AwarenessEvent[] = [];
  try {
    const s = state(sessionId);
    const prevText = s.lastText;

    // Schreibende Autoren als „frisch" merken: jede ClientID, deren Clock in dieser Transaktion
    // fortgeschritten ist (event.changes.added ist bei .observe() leer; afterState/beforeState sind verlässlich).
    const before = event.transaction.beforeState;
    event.transaction.afterState.forEach((clock, client) => {
      if ((before.get(client) ?? 0) < clock) s.recent.set(client, now);
    });

    const { deletions, primaryIndex, isInsert } = extractFromTextEvent(event, prevText);

    // Regel B: Edit-vs-Delete.
    if (deletions.length > 0) {
      const conflict = evaluateDeletion({ sessionId, actorUserId: ctx.actorUserId, deletions, authorOf: ctx.authorOf, recent: s.recent, now, isActive: ctx.isActive });
      if (conflict) events.push({ type: AWARENESS_EVENT.conflict, payload: conflict });
    }

    // Regel C: gleiche SQL-Anweisung.
    if (ctx.actorUserId) {
      const text = event.target.toString();
      const stmt = statementIndexAt(text, primaryIndex);
      const cConflict = evaluateStatementConflict({ sessionId, stmtIndex: stmt, editorUserId: ctx.actorUserId, previous: s.stmtEditors.get(stmt), now, isActive: ctx.isActive });
      if (cConflict) events.push({ type: AWARENESS_EVENT.conflict, payload: cConflict });
      s.stmtEditors.set(stmt, { userId: ctx.actorUserId, at: now });
    }

    // Passiver Feed (gedrosselt; die erste Änderung einer Session geht immer durch).
    if (s.lastFeed === 0 || now - s.lastFeed >= FEED_THROTTLE_MS) {
      s.lastFeed = now;
      const record: ChangeRecord = {
        sessionId,
        who: { userId: ctx.actorUserId ?? 'unbekannt' },
        what: deletions.length > 0 ? 'delete' : isInsert ? 'insert' : 'format',
        where: { index: primaryIndex, length: deletions.reduce((sum, d) => sum + d.length, 0) },
        when: new Date(now).toISOString(),
      };
      events.push({ type: AWARENESS_EVENT.change, payload: record });
    }

    s.lastText = event.target.toString(); // Stand für die nächste how.before-Rekonstruktion
  } catch {
    // Awareness darf den Sync niemals stören.
  }
  return events;
}

// ── Adapter A: an awareness.on('update', ...) hängen. Gibt Overlap-Hinweise zurück; gedrosselt. ─
export function onAwareness(sessionId: string, states: Map<number, unknown>, now: number = Date.now()): AwarenessEvent[] {
  const events: AwarenessEvent[] = [];
  try {
    const s = state(sessionId);
    if (now - s.lastOverlap < OVERLAP_THROTTLE_MS) return events;

    const cursors: { userId: string; name?: string; range: [number, number] }[] = [];
    states.forEach((st) => {
      const u = (st as { user?: { id?: string; name?: string }; cursor?: { anchor: number; head: number } });
      if (u?.user?.id && u.cursor) cursors.push({ userId: String(u.user.id), name: u.user.name, range: [u.cursor.anchor, u.cursor.head] });
    });
    for (let i = 0; i < cursors.length; i++) {
      for (let j = i + 1; j < cursors.length; j++) {
        const c = evaluateOverlap(cursors[i], cursors[j], sessionId, now);
        if (c) events.push({ type: AWARENESS_EVENT.conflict, payload: c });
      }
    }
    if (events.length > 0) s.lastOverlap = now;
  } catch {
    // defensiv
  }
  return events;
}

// Räumt den Zustand einer beendeten Session auf (gegen Memory-Wachstum).
export function resetSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// Test-Helfer.
export function _resetTracker(): void {
  sessions.clear();
}
