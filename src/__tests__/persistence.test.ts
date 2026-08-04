// M6 — Sync-Persistenz Tests
// Testet die setPersistence-Callbacks die beim Laden von controller.ts registriert werden.
// Prüft ob Snapshots korrekt gespeichert und geladen werden — Yjs-Dokument-Inhalt wird verifiziert.
import * as Y from 'yjs';

// y-websocket mocken damit setPersistence kontrolliert werden kann.
jest.mock('y-websocket/bin/utils', () => ({
  setupWSConnection: jest.fn(),
  setPersistence:    jest.fn(),
}));

jest.mock('../config/db', () => {
  const mockQuery = jest.fn();
  return {
    db: {
      query: mockQuery,
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({ query: mockQuery, release: jest.fn() })
      ),
    },
  };
});

jest.mock('../config/redis', () => ({
  redis: {
    getBuffer: jest.fn().mockResolvedValue(null), // kein Cache-Treffer per Default
    set:       jest.fn().mockResolvedValue('OK'),
  },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: { on: jest.fn() },
}));

// Controller laden → löst den module-level setPersistence({...})-Aufruf aus
import { setPersistence } from 'y-websocket/bin/utils';
import { db } from '../config/db';
import { redis } from '../config/redis';
import '../services/websocket/controller';

describe('M6 — Sync-Persistenz (setPersistence Callbacks)', () => {
  type PersistenceConfig = {
    bindState:  (sessionId: string, ydoc: Y.Doc) => Promise<void>;
    writeState: (sessionId: string, ydoc: Y.Doc) => Promise<void>;
  };

  let bindState:  PersistenceConfig['bindState'];
  let writeState: PersistenceConfig['writeState'];

  beforeAll(() => {
    // Callback-Objekt aus dem einmaligen setPersistence-Aufruf extrahieren
    const [config] = (setPersistence as jest.Mock).mock.calls[0] as [PersistenceConfig];
    bindState  = config.bindState;
    writeState = config.writeState;
  });

  beforeEach(() => jest.clearAllMocks());

  // ── bindState: Snapshot-Quellen ─────────────────────────────────────────────

  describe('bindState — Snapshot-Reihenfolge: Redis → PostgreSQL', () => {
    it('lädt aus Redis wenn ein Cache-Treffer vorhanden ist (kein DB-Aufruf)', async () => {
      const sourceDoc = new Y.Doc();
      sourceDoc.getText('content').insert(0, 'Aus Redis');
      const snapshot = Buffer.from(Y.encodeStateAsUpdate(sourceDoc));

      (redis.getBuffer as jest.Mock).mockResolvedValueOnce(snapshot);

      const ydoc = new Y.Doc();
      await bindState('session-redis', ydoc);

      expect(ydoc.getText('content').toString()).toBe('Aus Redis');
      expect(db.query).not.toHaveBeenCalled();
    });

    it('lädt aus PostgreSQL wenn Redis leer ist und cached den Snapshot danach in Redis', async () => {
      const sourceDoc = new Y.Doc();
      sourceDoc.getText('content').insert(0, 'Aus PostgreSQL');
      const snapshot = Buffer.from(Y.encodeStateAsUpdate(sourceDoc));

      (redis.getBuffer as jest.Mock).mockResolvedValueOnce(null);
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ content_snapshot: snapshot }] });

      const ydoc = new Y.Doc();
      await bindState('session-pg', ydoc);

      expect(ydoc.getText('content').toString()).toBe('Aus PostgreSQL');
      expect(redis.set).toHaveBeenCalledWith(
        'session:session-pg:snapshot',
        snapshot,
        'EX',
        expect.any(Number)
      );
    });

    it('lässt das Dokument leer wenn weder Redis noch PostgreSQL einen Snapshot haben', async () => {
      (redis.getBuffer as jest.Mock).mockResolvedValueOnce(null);
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const ydoc = new Y.Doc();
      await bindState('session-neu', ydoc);

      expect(ydoc.getText('content').toString()).toBe('');
    });

    it('fragt PostgreSQL mit der korrekten Session-ID ab', async () => {
      (redis.getBuffer as jest.Mock).mockResolvedValueOnce(null);
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await bindState('meine-session-id', new Y.Doc());

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT content_snapshot'),
        ['meine-session-id']
      );
    });

    it('wirft keinen Fehler wenn die DB beim Laden nicht erreichbar ist', async () => {
      (redis.getBuffer as jest.Mock).mockResolvedValueOnce(null);
      (db.query as jest.Mock).mockRejectedValueOnce(new Error('DB nicht erreichbar'));

      await expect(bindState('session-fehler', new Y.Doc())).resolves.not.toThrow();
    });
  });

  // ── bindState: Debounce-Verhalten ───────────────────────────────────────────

  describe('bindState — Debounce: Schreibung nach 5 Sekunden Inaktivität', () => {
    it('schreibt einen Snapshot in Redis und DB nach 5 Sekunden ohne weitere Änderung', async () => {
      jest.useFakeTimers();
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });

      const ydoc = new Y.Doc();
      await bindState('session-debounce', ydoc);
      jest.clearAllMocks();

      ydoc.getText('content').insert(0, 'Neue Zeile');

      // Debounce-Timer ablaufen lassen und alle Promises auflösen
      await jest.advanceTimersByTimeAsync(5000);

      // Debounce verwendet jetzt UPSERT (INSERT ON CONFLICT) statt reinem UPDATE,
      // damit auch neu angelegte Sessions (noch kein documents-Eintrag) korrekt gespeichert werden.
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO documents'),
        expect.arrayContaining(['session-debounce'])
      );
      expect(redis.set).toHaveBeenCalledWith(
        'session:session-debounce:snapshot',
        expect.any(Buffer),
        'EX',
        expect.any(Number)
      );

      jest.useRealTimers();
    });

    it('schreibt nur einmal wenn mehrere Änderungen schnell hintereinander kommen', async () => {
      jest.useFakeTimers();
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });

      const ydoc = new Y.Doc();
      await bindState('session-burst', ydoc);
      jest.clearAllMocks();

      // 3 schnelle Änderungen innerhalb von 1 Sekunde
      ydoc.getText('content').insert(0, 'A');
      await jest.advanceTimersByTimeAsync(300);
      ydoc.getText('content').insert(1, 'B');
      await jest.advanceTimersByTimeAsync(300);
      ydoc.getText('content').insert(2, 'C');

      // Jetzt 5 Sekunden warten bis der letzte Timer abläuft
      await jest.advanceTimersByTimeAsync(5000);

      // UPSERT (INSERT ON CONFLICT) statt reinem UPDATE — prüfe auf INSERT INTO documents
      const updateCalls = (db.query as jest.Mock).mock.calls
        .filter(([sql]: [string]) => sql.includes('INSERT INTO documents'));
      expect(updateCalls).toHaveLength(1);

      jest.useRealTimers();
    });

    it('wirft keinen Fehler wenn die DB beim Debounce-Snapshot nicht erreichbar ist', async () => {
      jest.useFakeTimers();
      (redis.getBuffer as jest.Mock).mockResolvedValueOnce(null);
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValue(new Error('Verbindung verloren'));

      const ydoc = new Y.Doc();
      await bindState('session-update-fehler', ydoc);

      ydoc.getText('content').insert(0, 'Trigger');

      await expect(jest.advanceTimersByTimeAsync(5000)).resolves.not.toThrow();

      jest.useRealTimers();
    });
  });

  // ── writeState: Finaler Snapshot ────────────────────────────────────────────

  describe('writeState — Finalen Snapshot in Redis und DB speichern', () => {
    it('schreibt den letzten Dokumentstand in die DB und erhöht die Version', async () => {
      // writeState macht 3 DB-Calls: UPDATE documents, COUNT history, INSERT history
      (db.query as jest.Mock).mockResolvedValue({ rows: [{ cnt: '0' }] });

      const ydoc = new Y.Doc();
      ydoc.getText('content').insert(0, 'Finaler Stand');

      await writeState('session-close', ydoc);

      // Buffer-Argumente nicht direkt mit toHaveBeenCalledWith prüfen — stattdessen gezielt
      const [[sqlArg, paramsArg]] = (db.query as jest.Mock).mock.calls;
      expect(sqlArg).toMatch(/version\s+=\s+documents\.version\s+\+\s+1/);
      expect(paramsArg).toContain('session-close');
    });

    it('schreibt den Snapshot zusätzlich in Redis', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [{ cnt: '0' }] });

      await writeState('session-close-redis', new Y.Doc());

      expect(redis.set).toHaveBeenCalledWith(
        'session:session-close-redis:snapshot',
        expect.any(Buffer),
        'EX',
        expect.any(Number)
      );
    });

    it('übergibt die Session-ID als zweiten Parameter an den DB-Query', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [{ cnt: '0' }] });

      await writeState('session-id-test', new Y.Doc());

      const [, params] = (db.query as jest.Mock).mock.calls[0];
      expect(params).toContain('session-id-test');
    });

    it('wirft keinen Fehler wenn die DB beim Abschließen nicht erreichbar ist', async () => {
      (db.query as jest.Mock).mockRejectedValueOnce(new Error('DB nicht erreichbar'));

      await expect(writeState('session-fehler', new Y.Doc())).resolves.not.toThrow();
    });
  });

  // ── M13: Reconnect-Zyklus ────────────────────────────────────────────────────
  // Abnahmekriterium M13: Nach Server-Neustart / Client-Reconnect muss der letzte
  // Dokumentstand wiederhergestellt werden.
  // Strategie: writeState speichert Snapshot in Redis → bindState liest ihn aus Redis →
  // neues Y.Doc enthält denselben Inhalt wie das Original.

  it('stellt Dokumentinhalt nach Reconnect vollständig wieder her (writeState → bindState)', async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [{ cnt: '0' }] });

    // Originaldokument mit bekanntem Inhalt
    const originalDoc = new Y.Doc();
    originalDoc.getText('content').insert(0, 'Reconnect-Inhalt');

    // writeState: schreibt Snapshot in Redis (gemockt) und DB
    await writeState('session-reconnect', originalDoc);

    // Den Buffer aus dem redis.set-Aufruf abfangen, den writeState geschrieben hat
    const setCall = (redis.set as jest.Mock).mock.calls.find(
      ([key]: [string]) => key === 'session:session-reconnect:snapshot'
    );
    expect(setCall).toBeDefined();
    const savedSnapshot = setCall![1] as Buffer;

    // Reconnect simulieren: redis.getBuffer gibt den gespeicherten Snapshot zurück
    (redis.getBuffer as jest.Mock).mockResolvedValueOnce(savedSnapshot);

    // bindState auf ein leeres neues Dokument — wie nach einem Reconnect
    const freshDoc = new Y.Doc();
    await bindState('session-reconnect', freshDoc);

    // Der Inhalt muss identisch mit dem Original sein
    expect(freshDoc.getText('content').toString()).toBe('Reconnect-Inhalt');
  });
});
