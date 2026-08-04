// M16 (Server-Anteil) — Offline-/Spät-Reconnect-Garantien des CRDT.
//
// Diese Suite belegt die Eigenschaften, auf denen die Offline-Fähigkeit BACKEND-seitig beruht.
// Offline selbst ist clientseitig (y-indexeddb in M10/M11) — der Server stellt sicher, dass
// zeitversetzte/lange-offline Bearbeitungen beim Reconnect VERLUSTFREI konvergieren.
//
// Reines Yjs (keine DB/Redis/WebSocket nötig) — schnell und deterministisch.
import * as Y from 'yjs';

describe('M16 — Offline-Merge-Garantien (Strong Eventual Consistency)', () => {

  it('führt divergente Offline-Bearbeitungen verlustfrei zusammen', () => {
    // Gemeinsamer Ausgangsstand
    const base = new Y.Doc();
    base.getText('content').insert(0, 'SELECT * FROM users');
    const baseUpdate = Y.encodeStateAsUpdate(base);

    // Zwei Clients starten vom selben Stand und gehen "offline"
    const clientA = new Y.Doc();
    const clientB = new Y.Doc();
    Y.applyUpdate(clientA, baseUpdate);
    Y.applyUpdate(clientB, baseUpdate);

    // Beide bearbeiten getrennt (offline)
    clientA.getText('content').insert(0, '-- von A\n');
    clientB.getText('content').insert(clientB.getText('content').length, '\n-- von B');

    // Reconnect: Updates werden ausgetauscht (in beide Richtungen)
    const updateA = Y.encodeStateAsUpdate(clientA);
    const updateB = Y.encodeStateAsUpdate(clientB);
    Y.applyUpdate(clientA, updateB);
    Y.applyUpdate(clientB, updateA);

    // Konvergenz: identischer Endzustand, beide Bearbeitungen erhalten
    expect(clientA.getText('content').toString()).toBe(clientB.getText('content').toString());
    expect(clientA.getText('content').toString()).toContain('-- von A');
    expect(clientA.getText('content').toString()).toContain('-- von B');
    expect(clientA.getText('content').toString()).toContain('SELECT * FROM users');
  });

  it('ist reihenfolge-unabhängig (kommutativ) — egal wer zuerst mergt', () => {
    const base = new Y.Doc();
    base.getText('content').insert(0, 'X');
    const baseUpdate = Y.encodeStateAsUpdate(base);

    const a = new Y.Doc(); Y.applyUpdate(a, baseUpdate);
    const b = new Y.Doc(); Y.applyUpdate(b, baseUpdate);
    const c = new Y.Doc(); Y.applyUpdate(c, baseUpdate);

    a.getText('content').insert(0, 'A');
    b.getText('content').insert(0, 'B');

    const ua = Y.encodeStateAsUpdate(a);
    const ub = Y.encodeStateAsUpdate(b);

    // c bekommt die Updates in der einen, ein weiterer Doc in umgekehrter Reihenfolge
    Y.applyUpdate(c, ua); Y.applyUpdate(c, ub);
    const d = new Y.Doc(); Y.applyUpdate(d, baseUpdate);
    Y.applyUpdate(d, ub); Y.applyUpdate(d, ua);

    expect(c.getText('content').toString()).toBe(d.getText('content').toString());
  });

  it('überträgt beim Spät-Reconnect nur das fehlende Delta (State-Vector)', () => {
    // Server mit großem Ausgangsstand
    const server = new Y.Doc();
    server.getText('content').insert(0, 'A'.repeat(1000));

    // Client kennt diesen Stand und merkt sich seinen State-Vector, dann "offline"
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    const clientStateVector = Y.encodeStateVector(client);

    // Während der Client offline ist, ändert sich am Server etwas Kleines
    server.getText('content').insert(server.getText('content').length, 'NEU');

    // Beim Reconnect liefert der Server nur das Delta relativ zum Client-State-Vector
    const delta = Y.encodeStateAsUpdate(server, clientStateVector);
    const full = Y.encodeStateAsUpdate(server);
    expect(delta.length).toBeLessThan(full.length); // Delta << Vollstand

    // Delta anwenden → Client ist wieder gleichauf
    Y.applyUpdate(client, delta);
    expect(client.getText('content').toString()).toBe(server.getText('content').toString());
    expect(client.getText('content').toString()).toContain('NEU');
  });

  it('konvergiert auch mit aktivierter Garbage Collection (gc:true) nach langer Offline-Phase', () => {
    // gc:true entspricht der Server-Konfiguration (setupWSConnection { gc: true })
    const server = new Y.Doc({ gc: true });
    server.getText('content').insert(0, 'Zeile 1\nZeile 2\nZeile 3');

    // Offline-Client kennt diesen Stand und bearbeitet OFFLINE
    const client = new Y.Doc({ gc: true });
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    client.getText('content').insert(0, '-- offline edit\n');
    const oldClientUpdate = Y.encodeStateAsUpdate(client); // vor dem Reconnect erzeugt

    // Server löscht inzwischen Inhalt → Tombstones können per GC aufgeräumt werden
    server.getText('content').delete(0, 'Zeile 1\n'.length);

    // Reconnect: der ALTE Offline-Update trifft auf den (ge-GC-ten) Server-Stand
    Y.applyUpdate(server, oldClientUpdate);
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

    // Trotz GC: Konvergenz, Offline-Edit erhalten, Löschung respektiert
    expect(server.getText('content').toString()).toBe(client.getText('content').toString());
    expect(server.getText('content').toString()).toContain('-- offline edit');
    expect(server.getText('content').toString()).toContain('Zeile 2');
    expect(server.getText('content').toString()).not.toContain('Zeile 1');
  });
});
