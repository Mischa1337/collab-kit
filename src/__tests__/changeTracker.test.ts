// Change/Conflict-Awareness — reine Regeln A/B/C (ohne Yjs) + Adapter (echtes Y.Doc). Kein DB/Redis.
import * as Y from 'yjs';
import {
  evaluateDeletion, evaluateOverlap, evaluateStatementConflict, statementIndexAt,
  onTextChange, onAwareness, _resetTracker, User,
} from '../services/collaboration/changeTracker';

const idUser = (c: number): User => ({ userId: String(c) });

describe('Regel B — evaluateDeletion (Edit-vs-Delete)', () => {
  const base = (over: Partial<Parameters<typeof evaluateDeletion>[0]> = {}) => ({
    sessionId: 's1',
    actorUserId: 'uB',
    deletions: [{ authorClientId: 1, length: 8, index: 5, text: 'Absatz' }],
    authorOf: (c: number): User => ({ userId: c === 1 ? 'uA' : 'u' + c }),
    recent: new Map<number, number>([[1, 99_000]]),
    now: 100_000,
    freshMs: 45_000,
    ...over,
  });

  it('flaggt: B löscht frischen Inhalt von A', () => {
    const r = evaluateDeletion(base());
    expect(r).not.toBeNull();
    expect(r!.victim.userId).toBe('uA');
    expect(r!.who.userId).toBe('uB');
    expect(r!.where).toEqual({ index: 5, length: 8 });
    expect(r!.how?.before).toBe('Absatz');
    expect(r!.severity).toBe('warning');
  });
  it('kein Flag bei eigener Löschung (Actor == Autor)', () => {
    expect(evaluateDeletion(base({ actorUserId: 'uA' }))).toBeNull();
  });
  it('kein Flag wenn nicht frisch', () => {
    expect(evaluateDeletion(base({ recent: new Map([[1, 100_000 - 60_000]]) }))).toBeNull();
  });
  it('kein Flag ohne recent-Marke', () => {
    expect(evaluateDeletion(base({ recent: new Map() }))).toBeNull();
  });
  it('kein Flag ohne Löschungen', () => {
    expect(evaluateDeletion(base({ deletions: [] }))).toBeNull();
  });
});

describe('Regel A — evaluateOverlap (proaktiver Overlap)', () => {
  it('flaggt info bei Cursor-Overlap zweier Nutzer', () => {
    const r = evaluateOverlap({ userId: 'uA', range: [0, 10] }, { userId: 'uB', range: [5, 15] }, 's1', 1000);
    expect(r).not.toBeNull();
    expect(r!.severity).toBe('info');
    expect(r!.where).toEqual({ index: 5, length: 5 });
  });
  it('kein Flag ohne Overlap', () => {
    expect(evaluateOverlap({ userId: 'uA', range: [0, 4] }, { userId: 'uB', range: [10, 12] }, 's1', 1000)).toBeNull();
  });
  it('kein Flag bei gleichem Nutzer', () => {
    expect(evaluateOverlap({ userId: 'uA', range: [0, 10] }, { userId: 'uA', range: [5, 9] }, 's1', 1000)).toBeNull();
  });
});

describe('Regel C — evaluateStatementConflict (gleiche Anweisung)', () => {
  const base = (over = {}) => ({ sessionId: 's1', stmtIndex: 2, editorUserId: 'uB', previous: { userId: 'uA', at: 99_000 }, now: 100_000, freshMs: 45_000, ...over });
  it('flaggt info bei zwei Nutzern an derselben Anweisung', () => {
    const r = evaluateStatementConflict(base());
    expect(r).not.toBeNull();
    expect(r!.severity).toBe('info');
    expect(r!.where.index).toBe(2);
  });
  it('kein Flag bei gleichem Editor', () => {
    expect(evaluateStatementConflict(base({ previous: { userId: 'uB', at: 99_000 } }))).toBeNull();
  });
  it('kein Flag wenn vorheriger Edit zu alt', () => {
    expect(evaluateStatementConflict(base({ previous: { userId: 'uA', at: 100_000 - 60_000 } }))).toBeNull();
  });
  it('kein Flag ohne vorherigen Editor', () => {
    expect(evaluateStatementConflict(base({ previous: undefined }))).toBeNull();
  });
});

describe('statementIndexAt', () => {
  it('zählt Anweisungen nach ; / Zeilenumbruch', () => {
    expect(statementIndexAt('SELECT 1; SELECT 2; SEL', 22)).toBe(2);
    expect(statementIndexAt('SELECT 1', 3)).toBe(0);
  });
});

describe('onTextChange (Yjs-Adapter, live)', () => {
  beforeEach(_resetTracker);

  it('liefert change_awareness-Feed bei einer Einfügung', () => {
    const doc = new Y.Doc();
    let events: ReturnType<typeof onTextChange> = [];
    doc.getText('content').observe((e) => { events = onTextChange('s1', e, { actorUserId: 'uA', authorOf: idUser }, 1000); });
    doc.getText('content').insert(0, 'hallo');
    expect(events.some((e) => e.type === 'change_awareness')).toBe(true);
  });

  it('Regel B: B löscht frischen Inhalt von A → semantic_conflict (warning)', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const authorOf = (c: number): User => (c === a.clientID ? { userId: 'uA' } : { userId: 'uB' });

    a.getText('content').observe((e) => onTextChange('s1', e, { actorUserId: 'uA', authorOf }, 1000));
    a.getText('content').insert(0, 'wichtiger Absatz');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    let events: ReturnType<typeof onTextChange> = [];
    b.getText('content').observe((e) => { events = onTextChange('s1', e, { actorUserId: 'uB', authorOf }, 2000); });
    b.getText('content').delete(0, 5);

    const conflict = events.find((e) => e.type === 'semantic_conflict');
    expect(conflict).toBeDefined();
    expect(conflict!.payload.severity).toBe('warning');
    expect(conflict!.payload.victim.userId).toBe('uA');
  });

  it('Regel C: zwei Nutzer ändern dieselbe Anweisung → semantic_conflict (info)', () => {
    const doc = new Y.Doc();
    let actor = 'uA';
    let nowVal = 1000;
    let events: ReturnType<typeof onTextChange> = [];
    doc.getText('content').observe((e) => { events = onTextChange('s1', e, { actorUserId: actor, authorOf: idUser }, nowVal); });

    actor = 'uA'; nowVal = 1000; doc.getText('content').insert(0, 'SELECT 1');
    actor = 'uB'; nowVal = 2000; doc.getText('content').insert(8, ' WHERE x');

    const conflict = events.find((e) => e.type === 'semantic_conflict' && e.payload.severity === 'info');
    expect(conflict).toBeDefined();
  });
});

describe('onAwareness (Regel A, live)', () => {
  beforeEach(_resetTracker);
  it('flaggt Overlap aus den Awareness-Cursorn', () => {
    const states = new Map<number, unknown>([
      [1, { user: { id: 'uA', name: 'A' }, cursor: { anchor: 0, head: 10 } }],
      [2, { user: { id: 'uB', name: 'B' }, cursor: { anchor: 6, head: 14 } }],
    ]);
    const events = onAwareness('s1', states, 5000);
    expect(events.some((e) => e.type === 'semantic_conflict' && e.payload.severity === 'info')).toBe(true);
  });
});
