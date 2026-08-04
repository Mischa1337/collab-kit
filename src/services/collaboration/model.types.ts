// Vertrag (D1) — Form des GETEILTEN Modell-Dokuments für das Modellierungstool (M11).
//
// Liegt NEBEN getText('content') (SQL-Editor) im selben Y.Doc. Dadurch wird das Modell
// vom bestehenden y-websocket-Sync UND der Persistenz (Y.encodeStateAsUpdate speichert das
// ganze Doc) automatisch mitsynchronisiert und -gespeichert — KEIN zusätzlicher Backend-Umbau.
//
// ░░ ERWEITERN ░░  = nur die Interfaces `ModelNode`/`ModelEdge` unten anpassen (ein paar Zeilen).
// Die Helfer kopieren Felder GENERISCH (Object.entries) → sie müssen NICHT geändert werden,
// wenn ein Feld dazukommt.
//
// HINWEIS: Dieses Modul ist bewusst NICHT serverseitig verdrahtet — es ist der
// FE-/Sync-Vertrag und wird mit M11 aktiv. Kein toter Code, nicht entfernen.
import * as Y from 'yjs';

// ── Eine Quelle der Wahrheit: wo im Y.Doc liegt was ───────────────────────────
export const MODEL = {
  elements: 'elements', // Y.Map<nodeId, Y.Map<field,value>> — Knoten/Entitäten
  edges: 'edges',       // Y.Map<edgeId, Y.Map<field,value>>  — Verbindungen (ID-adressiert, feldgenaues Merge)
} as const;

// ── Der Vertrag: Form eines Knotens / einer Kante ─────────────────────────────
// >>> HIER erweitern: einfach Felder ergänzen — z. B. `color?: string`, `columns?: string[]`.
export interface ModelNode {
  id: string;
  type: string;   // z. B. 'table' | 'entity' | 'note'
  label: string;
  x: number;
  y: number;
  width?: number;  // Zellgröße — beim Resize mitgeben, sonst synct die Größenänderung nicht (s. Schicht-2/M11).
  height?: number; // Zellgröße — siehe width.
  style?: string; // MaxGraph-Style-String (Farben/Formen) — beim Schreiben mitgeben, sonst gehen Styles verloren.
  // color?: string;   // ← Beispiel: weitere Felder einfach ergänzen, die Helfer kopieren generisch.
}

export interface ModelEdge {
  id: string;
  from: string;   // ModelNode.id
  to: string;     // ModelNode.id
  label?: string;
  style?: string; // MaxGraph-Style-String der Kante.
}

// ── Zugriff auf die geteilten Typen ───────────────────────────────────────────
export function elements(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(MODEL.elements) as Y.Map<Y.Map<unknown>>;
}
export function edges(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(MODEL.edges) as Y.Map<Y.Map<unknown>>;
}

// ── Helfer (feld-generisch → bei neuen Feldern NICHT anzupassen) ──────────────
// Knoten anlegen/aktualisieren: jedes Feld liegt einzeln in der Y.Map → zwei Nutzer können
// verschiedene Felder/Knoten gleichzeitig ändern, ohne sich gegenseitig zu überschreiben.
export function upsertNode(doc: Y.Doc, node: ModelNode): void {
  // In EINER Transaktion: atomar für alle Beobachter (Sync + Schicht 2) und ein einziger
  // Event-Batch statt eines pro Feld.
  doc.transact(() => {
    const map = elements(doc);
    let yn = map.get(node.id);
    if (!yn) { yn = new Y.Map<unknown>(); map.set(node.id, yn); }
    for (const [k, v] of Object.entries(node)) yn.set(k, v);
  });
}

export function readNode(yn: Y.Map<unknown>): ModelNode {
  return Object.fromEntries(yn.entries()) as unknown as ModelNode;
}

export function removeNode(doc: Y.Doc, id: string): void {
  elements(doc).delete(id);
}

// Kante anlegen/aktualisieren: ID-adressiert (Y.Map<edgeId, …>) — wie upsertNode. Dadurch mergt Yjs
// Kanten feldgenau und idempotent (keine Duplikate bei Gleichzeitigkeit; früher Y.Array + push).
export function addEdge(doc: Y.Doc, edge: ModelEdge): void {
  doc.transact(() => {
    const map = edges(doc);
    let ye = map.get(edge.id);
    if (!ye) { ye = new Y.Map<unknown>(); map.set(edge.id, ye); }
    for (const [k, v] of Object.entries(edge)) ye.set(k, v);
  });
}

export function removeEdge(doc: Y.Doc, id: string): void {
  doc.transact(() => { edges(doc).delete(id); });
}

// Plain-JSON-Sicht des ganzen Modells (für Export/Debug/FE-Initialrender).
export function toPlainModel(doc: Y.Doc): { nodes: ModelNode[]; edges: ModelEdge[] } {
  const nodes: ModelNode[] = [];
  elements(doc).forEach((yn) => nodes.push(readNode(yn)));
  const es: ModelEdge[] = [];
  edges(doc).forEach((ye) => es.push(Object.fromEntries(ye.entries()) as unknown as ModelEdge));
  return { nodes, edges: es };
}
