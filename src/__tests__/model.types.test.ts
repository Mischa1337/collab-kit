// D1-Vertrag — zeigt den Nutzen strukturierter Y-Typen (gegenüber reinem Text):
// konfliktfreie, feingranulare Nebenläufigkeit + strukturierte Abfrage + einfache Erweiterbarkeit.
import * as Y from 'yjs';
import { upsertNode, addEdge, removeEdge, toPlainModel, ModelNode } from '../services/collaboration/model.types';

describe('D1 — Modell-Vertrag (strukturierte Y-Typen)', () => {
  it('zwei Nutzer ändern gleichzeitig verschiedene Knoten/Felder → konfliktfrei zusammengeführt', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    upsertNode(a, { id: 't1', type: 'table', label: 'users', x: 0, y: 0 });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); // b kennt t1

    // gleichzeitig: A verschiebt t1, B legt t2 an
    upsertNode(a, { id: 't1', type: 'table', label: 'users', x: 100, y: 0 });
    upsertNode(b, { id: 't2', type: 'table', label: 'orders', x: 50, y: 50 });

    // in beide Richtungen syncen
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    const ma = toPlainModel(a);
    expect(ma).toEqual(toPlainModel(b));                          // konvergiert (kein manuelles Merge)
    expect(ma.nodes.find((n) => n.id === 't1')!.x).toBe(100);    // A's Verschiebung erhalten
    expect(ma.nodes.map((n) => n.id).sort()).toEqual(['t1', 't2']); // B's neuer Knoten erhalten
  });

  it('strukturierte Abfrage + Kanten ohne Text-Parsing', () => {
    const d = new Y.Doc();
    upsertNode(d, { id: 't1', type: 'table', label: 'users', x: 0, y: 0 });
    upsertNode(d, { id: 't2', type: 'table', label: 'orders', x: 10, y: 0 });
    addEdge(d, { id: 'e1', from: 't1', to: 't2', label: 'fk' });
    const m = toPlainModel(d);
    expect(m.nodes).toHaveLength(2);
    expect(m.edges[0]).toMatchObject({ from: 't1', to: 't2', label: 'fk' });
  });

  // Part A — Kanten liegen als ID-adressierte Y.Map<edgeId> (statt Y.Array + „alles löschen/neu pushen").
  it('gleichzeitige Kanten-Änderungen mergen OHNE Duplikate', () => {
    const base = new Y.Doc();
    addEdge(base, { id: 'e1', from: 'n1', to: 'n2', label: 'x' });
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));

    addEdge(a, { id: 'e1', from: 'n1', to: 'n2', label: 'A-NEU' }); // A benennt e1 um
    addEdge(b, { id: 'e2', from: 'n2', to: 'n3', label: 'y' });     // B fügt e2 hinzu

    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    const ma = toPlainModel(a);
    expect(ma).toEqual(toPlainModel(b));                              // konvergiert
    expect(ma.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);  // e1 GENAU EINMAL (kein Duplikat)
    expect(ma.edges.find((e) => e.id === 'e1')!.label).toBe('A-NEU');
  });

  it('kausal: gelöschte Kante zurückholen bleibt bestehen (Merge-Rückführung, „Beide behalten")', () => {
    const base = new Y.Doc();
    addEdge(base, { id: 'e1', from: 'n1', to: 'n2', label: 'orig' });
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));

    removeEdge(a, 'e1');                                   // A löscht
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));            // B sieht die Löschung …
    addEdge(b, { id: 'e1', from: 'n1', to: 'n2', label: 'orig' }); // … und holt e1 KAUSAL danach zurück
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const ma = toPlainModel(a);
    expect(ma).toEqual(toPlainModel(b));
    expect(ma.edges.map((e) => e.id)).toEqual(['e1']);    // genau einmal — Rückführung gewinnt, kein Duplikat
  });

  it('neues Feld = nur das Interface erweitern (Helfer bleiben unverändert)', () => {
    const d = new Y.Doc();
    // FE-Sicht: ModelNode wurde z. B. um `color` ergänzt — Helfer müssen NICHT angepasst werden.
    const node: ModelNode & { color: string } = { id: 'n1', type: 'note', label: 'x', x: 0, y: 0, color: '#e11' };
    upsertNode(d, node);
    const read = toPlainModel(d).nodes[0] as ModelNode & { color?: string };
    expect(read.color).toBe('#e11');
  });
});
