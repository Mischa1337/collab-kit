// Change/Conflict-Awareness (Schicht 2) für das strukturierte MODELL (M11) — Y.Map 'elements'
// (Knoten) + Y.Map 'edges' (Kanten, ID-adressiert — NICHT Y.Array, siehe model.types.ts:74).
// Pendant zu changeTracker.ts (Text), gleiche Relevanz-Tore
// (Frische, Opfer-aktiv, eigene-Aktion), advisory (ändert das Modell nie).
//
// Erkennung über SNAPSHOT-DIFF: pro Transaktion wird der aktuelle Plain-Stand (toPlainModel)
// gegen den letzten verglichen. Das liefert verlässlich BEIDES, was die rohen Yjs-Events nicht
// hergeben: die gelöschten Knotendaten (how.before, sonst durch GC leer) UND die edgeId einer
// gelöschten Kante (das Array-Delta liefert nur die Anzahl). lastModel ersetzt das frühere,
// unzuverlässige oldValue/Delta-Auslesen — analog zu lastText im Text-Tracker.
import type * as Y from 'yjs';
import { ChangeRecord, AwarenessEvent, AWARENESS_EVENT, ChangeWhat, ConflictPayload } from './awareness.types';
import { toPlainModel } from './model.types';
import { settings } from '../../config/settings';

const FRESH_MS = settings.awareness.freshMs;
const FEED_THROTTLE_MS = settings.awareness.feedThrottleMs;
// Normaler Cooldown: nach einem gezeigten Konflikt für (Element, Opfer) diese Zeit lang keinen
// zweiten erzeugen, auch wenn technisch weitere kleine Änderungen reinkommen (z. B. Drag-Frames).
// Bewusst kurz gehalten: ein zu langer Cooldown würde einen echten NEUEN Konflikt am selben
// Element/Opfer verschlucken, der zufällig ins selbe Zeitfenster fällt.
const CONFLICT_COOLDOWN_MS = settings.conflict.cooldownMs;
// Cooldown nach einer BEWUSSTEN Reaktion (Behalten/Verwerfen) — etwas länger als der normale,
// aber ebenfalls kurz gehalten (s.o.).
const CONFLICT_ACK_SUPPRESS_MS = settings.conflict.ackSuppressMs;

// Plain-Form des Modells (wie model.types.toPlainModel liefert).
export interface PlainModel {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}
const EMPTY_MODEL: PlainModel = { nodes: [], edges: [] };

// Brücke: das geteilte Y.Doc → Plain-Stand (eine Stelle für den Typ-Cast).
export function modelOf(doc: Y.Doc): PlainModel {
  const { nodes, edges } = toPlainModel(doc);
  return { nodes: nodes as unknown as Array<Record<string, unknown>>, edges: edges as unknown as Array<Record<string, unknown>> };
}

// Eine normalisierte Modell-Änderung (aus dem Diff).
export interface ModelChange {
  what: ChangeWhat;     // node.added | node.moved | node.deleted | edge.created | edge.deleted | field.changed
  elementId?: string;   // Knoten-ID
  edgeId?: string;      // Kanten-ID
  field?: string;       // geändertes Feld (bei field.changed / node.moved)
  before?: unknown;     // Vorzustand (gelöschter Knoten/Kante / alter Feldwert) — aus dem letzten Snapshot
}

export interface ModelContext {
  actorUserId: string | null;             // wer die Änderung ausgelöst hat (tr.origin → conn)
  isActive?: (userId: string) => boolean; // A1: Opfer muss (noch) verbunden sein
}

interface ModelState {
  elementEditors: Map<string, { userId: string; at: number }>; // letzter Bearbeiter je Element-Key
  lastModel: PlainModel;                                        // Vorzustand für den Diff
  lastFeed: number;
  // Dedup/Cooldown: unterdrückt für (Element+Opfer) einen erneuten Konflikt für eine Weile,
  // nachdem einer gezeigt wurde — sonst erzeugt jede kleine Zwischenänderung am selben Element
  // (z. B. während eines Drags) einen eigenen, neuen Konflikt-Toast/-Dialog für dasselbe Opfer.
  conflictCooldowns: Map<string, number>; // Key: `${elementKey}|${victimUserId}` → gesperrt bis (ms)
}
const sessions = new Map<string, ModelState>();
function state(sessionId: string): ModelState {
  let s = sessions.get(sessionId);
  if (!s) { s = { elementEditors: new Map(), lastModel: EMPTY_MODEL, lastFeed: 0, conflictCooldowns: new Map() }; sessions.set(sessionId, s); }
  return s;
}

const keyOf = (c: ModelChange): string | undefined => c.elementId ?? c.edgeId;
const isDeletion = (w: ChangeWhat): boolean => w === 'node.deleted' || w === 'edge.deleted';

function indexById(arr: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const x of arr) if (x && x.id != null) m.set(String(x.id), x);
  return m;
}

// ── Snapshot-Diff (rein): voriger vs. aktueller Plain-Stand → normalisierte Änderungen. ────────
export function diffModel(prev: PlainModel, curr: PlainModel): ModelChange[] {
  const out: ModelChange[] = [];
  const pn = indexById(prev.nodes), cn = indexById(curr.nodes);

  // Knoten: hinzugefügt / Felder geändert
  for (const [id, node] of cn) {
    const old = pn.get(id);
    if (!old) { out.push({ what: 'node.added', elementId: id }); continue; }
    for (const k of Object.keys(node)) {
      if (k === 'id') continue;
      if (JSON.stringify(old[k]) !== JSON.stringify(node[k])) {
        out.push({ what: (k === 'x' || k === 'y') ? 'node.moved' : 'field.changed', elementId: id, field: k, before: old[k] });
      }
    }
  }
  // Knoten: gelöscht (before = letzter bekannter Stand → echte Daten trotz GC)
  for (const [id, node] of pn) if (!cn.has(id)) out.push({ what: 'node.deleted', elementId: id, before: node });

  // Kanten (über die ID): erstellt / gelöscht (mit ID, da aus dem Snapshot)
  const pe = indexById(prev.edges), ce = indexById(curr.edges);
  for (const [id] of ce) if (!pe.has(id)) out.push({ what: 'edge.created', edgeId: id });
  for (const [id, edge] of pe) if (!ce.has(id)) out.push({ what: 'edge.deleted', edgeId: id, before: edge });

  return out;
}

// ── Regel B (rein): jemand löscht ein FRISCH von einem ANDEREN angelegtes/bearbeitetes Element. ─
export function evaluateModelDeletion(input: {
  sessionId: string;
  actorUserId: string | null;
  change: ModelChange;
  previous: { userId: string; at: number } | undefined;
  now: number;
  freshMs?: number;
  isActive?: (userId: string) => boolean;
}): ConflictPayload | null {
  const fresh = input.freshMs ?? FRESH_MS;
  const p = input.previous;
  if (!p) return null;
  if (input.actorUserId && p.userId === input.actorUserId) return null; // eigene Löschung
  if (input.now - p.at > fresh) return null;                            // nicht frisch
  if (input.isActive && !input.isActive(p.userId)) return null;         // Opfer nicht (mehr) aktiv
  return {
    sessionId: input.sessionId,
    who: { userId: input.actorUserId ?? 'unbekannt' },
    what: input.change.what,
    where: { target: 'model', elementId: input.change.elementId, edgeId: input.change.edgeId },
    how: { before: input.change.before, after: undefined },
    when: new Date(input.now).toISOString(),
    severity: 'warning',
    victim: { userId: p.userId },
  };
}

// ── Regel C (rein): zwei verschiedene Nutzer bearbeiten DASSELBE Element kurz nacheinander. ─────
export function evaluateSameElement(input: {
  sessionId: string;
  editorUserId: string;
  change: ModelChange;
  previous: { userId: string; at: number } | undefined;
  now: number;
  freshMs?: number;
  isActive?: (userId: string) => boolean;
}): ConflictPayload | null {
  const fresh = input.freshMs ?? FRESH_MS;
  const p = input.previous;
  if (!p || p.userId === input.editorUserId || input.now - p.at > fresh) return null;
  if (input.isActive && !input.isActive(p.userId)) return null;
  return {
    sessionId: input.sessionId,
    who: { userId: input.editorUserId },
    what: input.change.what,
    where: { target: 'model', elementId: input.change.elementId, edgeId: input.change.edgeId, field: input.change.field },
    when: new Date(input.now).toISOString(),
    severity: 'info',
    victim: { userId: p.userId },
  };
}

// Prüft/aktualisiert den Cooldown für (Element, Opfer): true = darf jetzt einen Konflikt
// auslösen (und sperrt gleich für CONFLICT_COOLDOWN_MS), false = noch gesperrt → unterdrücken.
function shouldNotifyConflict(s: ModelState, key: string, victimUserId: string, now: number): boolean {
  const cdKey = `${key}|${victimUserId}`;
  const suppressUntil = s.conflictCooldowns.get(cdKey) ?? 0;
  if (now < suppressUntil) return false;
  s.conflictCooldowns.set(cdKey, now + CONFLICT_COOLDOWN_MS);
  return true;
}

// Vom "Behalten"/"Verwerfen"-Reaktions-Endpoint aufgerufen: sperrt (Element, Opfer) deutlich
// länger als der normale Cooldown, damit der gerade quittierte Konflikt nicht Sekunden später
// erneut auftaucht, nur weil zufällig eine weitere kleine Änderung am selben Element reinkommt.
export function acknowledgeConflict(sessionId: string, elementKey: string, victimUserId: string, now: number = Date.now()): void {
  state(sessionId).conflictCooldowns.set(`${elementKey}|${victimUserId}`, now + CONFLICT_ACK_SUPPRESS_MS);
}

// ── Adapter: aktuellen Plain-Stand gegen den letzten diffen → Events; Zustand aktualisieren. ────
export function onModelChange(
  sessionId: string,
  ctx: ModelContext,
  current: PlainModel,
  now: number = Date.now(),
): AwarenessEvent[] {
  const events: AwarenessEvent[] = [];
  try {
    const s = state(sessionId);
    const changes = diffModel(s.lastModel, current);

    for (const c of changes) {
      const key = keyOf(c);
      const previous = key ? s.elementEditors.get(key) : undefined;

      if (isDeletion(c.what)) {
        const conflict = evaluateModelDeletion({ sessionId, actorUserId: ctx.actorUserId, change: c, previous, now, isActive: ctx.isActive });
        if (conflict && key && shouldNotifyConflict(s, key, conflict.victim.userId, now)) {
          events.push({ type: AWARENESS_EVENT.conflict, payload: conflict });
        }
        if (key) s.elementEditors.delete(key);
      } else if (ctx.actorUserId && key) {
        const conflict = evaluateSameElement({ sessionId, editorUserId: ctx.actorUserId, change: c, previous, now, isActive: ctx.isActive });
        if (conflict && shouldNotifyConflict(s, key, conflict.victim.userId, now)) {
          events.push({ type: AWARENESS_EVENT.conflict, payload: conflict });
        }
        s.elementEditors.set(key, { userId: ctx.actorUserId, at: now });
      }
    }

    // Passiver Feed (gedrosselt; die erste Änderung einer Session geht immer durch).
    if (changes.length > 0 && (s.lastFeed === 0 || now - s.lastFeed >= FEED_THROTTLE_MS)) {
      s.lastFeed = now;
      const c = changes[0];
      const record: ChangeRecord = {
        sessionId,
        who: { userId: ctx.actorUserId ?? 'unbekannt' },
        what: c.what,
        where: { target: 'model', elementId: c.elementId, edgeId: c.edgeId, field: c.field },
        when: new Date(now).toISOString(),
      };
      events.push({ type: AWARENESS_EVENT.change, payload: record });
    }

    s.lastModel = current; // Basis für den nächsten Diff
  } catch {
    // Awareness darf den Sync niemals stören.
  }
  return events;
}

// Basis-Stand setzen, ohne Events zu erzeugen (beim Laden einer Session, damit bestehende
// Knoten/Kanten nicht fälschlich als „neu" gemeldet werden).
export function seedModel(sessionId: string, current: PlainModel): void {
  state(sessionId).lastModel = current;
}

// Aufräumen beim Session-Ende (gegen Memory-Wachstum).
export function resetModelSession(sessionId: string): void { sessions.delete(sessionId); }
export function _resetModelTracker(): void { sessions.clear(); }
