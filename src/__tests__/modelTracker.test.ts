// Schicht 2 fürs MODELL — Snapshot-Diff, reine Regeln, Adapter (onModelChange) und End-to-End
// mit echtem Y.Doc (beweist how.before mit ECHTEN Daten trotz GC + edgeId bei Löschung).
import * as Y from 'yjs';
import {
  onModelChange, diffModel, evaluateModelDeletion, evaluateSameElement,
  seedModel, modelOf, _resetModelTracker, PlainModel,
} from '../services/collaboration/modelTracker';
import { upsertNode, removeNode, addEdge, edges as modelEdges } from '../services/collaboration/model.types';

const T0 = 1_000_000;
const m = (nodes: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>> = []): PlainModel => ({ nodes, edges });

beforeEach(() => _resetModelTracker());

describe('diffModel (rein)', () => {
  it('neuer Knoten → node.added', () => {
    expect(diffModel(m([]), m([{ id: 't1', x: 0 }]))).toEqual([{ what: 'node.added', elementId: 't1' }]);
  });
  it('x/y geändert → node.moved mit before; anderes Feld → field.changed', () => {
    const d = diffModel(m([{ id: 't1', x: 0, label: 'A' }]), m([{ id: 't1', x: 9, label: 'B' }]));
    expect(d).toContainEqual({ what: 'node.moved', elementId: 't1', field: 'x', before: 0 });
    expect(d).toContainEqual({ what: 'field.changed', elementId: 't1', field: 'label', before: 'A' });
  });
  it('Knoten gelöscht → node.deleted mit before-Daten', () => {
    expect(diffModel(m([{ id: 't1', label: 'Kunde' }]), m([]))).toEqual([
      { what: 'node.deleted', elementId: 't1', before: { id: 't1', label: 'Kunde' } },
    ]);
  });
  it('Kante erstellt/gelöscht → edge.created / edge.deleted mit ID', () => {
    expect(diffModel(m([], []), m([], [{ id: 'e1' }]))).toEqual([{ what: 'edge.created', edgeId: 'e1' }]);
    expect(diffModel(m([], [{ id: 'e1', from: 'a' }]), m([], []))).toEqual([
      { what: 'edge.deleted', edgeId: 'e1', before: { id: 'e1', from: 'a' } },
    ]);
  });
});

describe('Reine Regeln', () => {
  it('Regel B: frischen Fremd-Knoten löschen → warning + victim + how.before', () => {
    const c = evaluateModelDeletion({
      sessionId: 's1', actorUserId: 'bob',
      change: { what: 'node.deleted', elementId: 't1', before: { label: 'Kunde' } },
      previous: { userId: 'alice', at: T0 }, now: T0 + 1000,
    });
    expect(c?.severity).toBe('warning');
    expect(c?.victim.userId).toBe('alice');
    expect(c?.how?.before).toEqual({ label: 'Kunde' });
  });
  it('Regel B: eigene Löschung / nicht frisch / Opfer inaktiv → kein Konflikt', () => {
    const base = { sessionId: 's1', change: { what: 'node.deleted' as const, elementId: 't1' }, previous: { userId: 'alice', at: T0 } };
    expect(evaluateModelDeletion({ ...base, actorUserId: 'alice', now: T0 + 1000 })).toBeNull();
    expect(evaluateModelDeletion({ ...base, actorUserId: 'bob', now: T0 + 60_000, freshMs: 45_000 })).toBeNull();
    expect(evaluateModelDeletion({ ...base, actorUserId: 'bob', now: T0 + 1000, isActive: () => false })).toBeNull();
  });
  it('Regel C: dasselbe Element kurz nacheinander → info', () => {
    const c = evaluateSameElement({
      sessionId: 's1', editorUserId: 'bob',
      change: { what: 'node.moved', elementId: 't1', field: 'x' },
      previous: { userId: 'alice', at: T0 }, now: T0 + 500,
    });
    expect(c?.severity).toBe('info');
    expect(c?.victim.userId).toBe('alice');
  });
});

describe('onModelChange (Snapshot-Diff-Adapter)', () => {
  it('Feed: neue Änderung → change_awareness mit Modell-Adressierung', () => {
    const evs = onModelChange('s1', { actorUserId: 'alice' }, m([{ id: 't1' }]), T0);
    const feed = evs.find(e => e.type === 'change_awareness');
    expect(feed?.payload.what).toBe('node.added');
    expect(feed?.payload.where).toEqual({ target: 'model', elementId: 't1', edgeId: undefined, field: undefined });
  });

  it('Regel C: alice editiert t1, dann bob → semantic_conflict info, victim alice', () => {
    onModelChange('s1', { actorUserId: 'alice' }, m([{ id: 't1', x: 0 }]), T0);
    const evs = onModelChange('s1', { actorUserId: 'bob' }, m([{ id: 't1', x: 5 }]), T0 + 1000);
    const conflict = evs.find(e => e.type === 'semantic_conflict');
    expect(conflict?.payload.severity).toBe('info');
    expect((conflict?.payload as { victim: { userId: string } }).victim.userId).toBe('alice');
  });

  it('Regel B: alice legt t2 an, bob löscht t2 frisch → warning mit echten how.before-Daten', () => {
    onModelChange('s1', { actorUserId: 'alice' }, m([{ id: 't2', label: 'X' }]), T0);
    const evs = onModelChange('s1', { actorUserId: 'bob' }, m([]), T0 + 2000);
    const conflict = evs.find(e => e.type === 'semantic_conflict');
    expect(conflict?.payload.severity).toBe('warning');
    expect((conflict?.payload.how?.before as { label: string }).label).toBe('X');
  });

  it('edge.deleted trägt die edgeId → Konflikt möglich', () => {
    onModelChange('s1', { actorUserId: 'alice' }, m([], [{ id: 'e1', from: 'a', to: 'b' }]), T0);
    const evs = onModelChange('s1', { actorUserId: 'bob' }, m([], []), T0 + 1000);
    const conflict = evs.find(e => e.type === 'semantic_conflict');
    expect(conflict?.payload.where.edgeId).toBe('e1');
    expect((conflict?.payload as { victim: { userId: string } }).victim.userId).toBe('alice');
  });

  it('eigene Folge-Aktion erzeugt keinen Konflikt', () => {
    onModelChange('s1', { actorUserId: 'alice' }, m([{ id: 't3' }]), T0);
    const evs = onModelChange('s1', { actorUserId: 'alice' }, m([]), T0 + 1000);
    expect(evs.find(e => e.type === 'semantic_conflict')).toBeUndefined();
  });
});

describe('End-to-End mit echtem Y.Doc (GC aktiv)', () => {
  it('how.before enthält die ECHTEN gelöschten Knotendaten (nicht leer)', () => {
    const doc = new Y.Doc();
    seedModel('sx', modelOf(doc));

    upsertNode(doc, { id: 't1', type: 'table', label: 'Kunde', x: 0, y: 0 });
    const a = onModelChange('sx', { actorUserId: 'alice' }, modelOf(doc), T0);
    expect(a.find(e => e.type === 'change_awareness')?.payload.what).toBe('node.added');

    removeNode(doc, 't1');
    const b = onModelChange('sx', { actorUserId: 'bob' }, modelOf(doc), T0 + 1000);
    const conflict = b.find(e => e.type === 'semantic_conflict');
    expect(conflict?.payload.severity).toBe('warning');
    expect((conflict?.payload.how?.before as { label: string }).label).toBe('Kunde'); // ECHTE Daten trotz GC
  });

  it('Kante anlegen + löschen über echtes Doc → edge.created/edge.deleted', () => {
    const doc = new Y.Doc();
    seedModel('sy', modelOf(doc));

    addEdge(doc, { id: 'e1', from: 't1', to: 't2' });
    const a = onModelChange('sy', { actorUserId: 'alice' }, modelOf(doc), T0);
    expect(a.find(e => e.type === 'change_awareness')?.payload.what).toBe('edge.created');

    modelEdges(doc).delete('e1');
    const b = onModelChange('sy', { actorUserId: 'bob' }, modelOf(doc), T0 + 1000);
    const conflict = b.find(e => e.type === 'semantic_conflict');
    expect(conflict?.payload.where.edgeId).toBe('e1');
  });
});
