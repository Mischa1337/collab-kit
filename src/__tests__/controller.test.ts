// N4 — WebSocket-Controller Tests
// Testet die exportierten Funktionen: broadcastToSession, getActiveSessionCount,
// getActiveWsConnectionCount und closeWebSocketServer.
// DB, Redis und y-websocket werden gemockt — kein Docker nötig.
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import { app } from '../app';
import {
  setupWebSocketServer,
  broadcastToSession,
  getActiveSessionCount,
  getActiveWsConnectionCount,
  closeWebSocketServer,
} from '../services/websocket/controller';
import { redis } from '../config/redis';
import { db } from '../config/db';
import { setPersistence } from 'y-websocket/bin/utils';
import * as Y from 'yjs';
import { upsertAutoVersion } from '../services/history/history.service';

const SESSION_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SESSION_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

jest.mock('../config/db', () => ({
  db: {
    query: jest.fn().mockResolvedValue({ rows: [{ id: 'mock-session' }] }),
  },
}));

jest.mock('../config/redis', () => ({
  redis: {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    getBuffer: jest.fn().mockResolvedValue(null),
    publish: jest.fn().mockResolvedValue(1),
    scan: jest.fn().mockResolvedValue(['0', []]),
  },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: {
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('y-websocket/bin/utils', () => ({
  setupWSConnection: jest.fn(),
  setPersistence: jest.fn(),
  docs: new Map(),
}));

jest.mock('../services/history/history.service', () => ({
  upsertAutoVersion: jest.fn().mockResolvedValue(undefined),
}));

// bindState/writeState werden beim Laden des Controllers registriert (Modul-Ebene).
// clearMocks:true würde mock.calls vor jedem Test leeren — daher hier sofort abgreifen,
// bevor irgendein Test-Lifecycle startet.
const _persistenceCall = (setPersistence as jest.Mock).mock.calls[0]?.[0];
const bindStateHandler: (sessionId: string, ydoc: Y.Doc) => Promise<void> = _persistenceCall?.bindState;
const writeStateHandler: (sessionId: string, ydoc: Y.Doc) => Promise<void> = _persistenceCall?.writeState;

// Öffnet eine WS-Verbindung und wartet bis sie wirklich offen ist.
function connect(port: number, sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/sync/${sessionId}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Schließt eine WS-Verbindung und wartet bis sie wirklich geschlossen ist.
function disconnect(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.on('close', () => setTimeout(resolve, 30));
    ws.close();
  });
}

describe('N4 — WebSocket Controller', () => {
  let server: Server;
  let port: number;

  beforeAll((done) => {
    server = createServer(app);
    setupWebSocketServer(server);
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    (redis.publish as jest.Mock).mockClear();
  });

  // ── broadcastToSession ────────────────────────────────────────────────────────

  describe('broadcastToSession', () => {
    it('publiziert auf den richtigen Redis-Kanal', () => {
      broadcastToSession(SESSION_A, { type: 'test_event' });

      expect(redis.publish).toHaveBeenCalledWith(
        `session:${SESSION_A}:events`,
        JSON.stringify({ type: 'test_event' })
      );
    });

    it('serialisiert beliebige Objekte korrekt als JSON', () => {
      const data = { type: 'comment.created', id: 'c1', text: 'Test' };
      broadcastToSession(SESSION_B, data);

      expect(redis.publish).toHaveBeenCalledWith(
        `session:${SESSION_B}:events`,
        JSON.stringify(data)
      );
    });

    it('verwendet verschiedene Kanäle für verschiedene Sessions', () => {
      broadcastToSession(SESSION_A, { type: 'a' });
      broadcastToSession(SESSION_B, { type: 'b' });

      const calls = (redis.publish as jest.Mock).mock.calls;
      expect(calls[0][0]).toBe(`session:${SESSION_A}:events`);
      expect(calls[1][0]).toBe(`session:${SESSION_B}:events`);
    });
  });

  // ── getActiveSessionCount ─────────────────────────────────────────────────────

  describe('getActiveSessionCount', () => {
    it('gibt 0 zurück wenn keine Verbindungen offen sind', () => {
      expect(getActiveSessionCount()).toBe(0);
    });

    it('steigt wenn eine Session verbunden wird und sinkt nach Disconnect', async () => {
      const ws = await connect(port, SESSION_A);
      expect(getActiveSessionCount()).toBeGreaterThanOrEqual(1);
      await disconnect(ws);
      expect(getActiveSessionCount()).toBe(0);
    });

    it('zählt zwei unterschiedliche Sessions als 2', async () => {
      const ws1 = await connect(port, SESSION_A);
      const ws2 = await connect(port, SESSION_B);
      expect(getActiveSessionCount()).toBeGreaterThanOrEqual(2);
      await disconnect(ws1);
      await disconnect(ws2);
    });
  });

  // ── getActiveWsConnectionCount ────────────────────────────────────────────────

  describe('getActiveWsConnectionCount', () => {
    it('gibt 0 zurück wenn keine Verbindungen offen sind', () => {
      expect(getActiveWsConnectionCount()).toBe(0);
    });

    it('steigt bei einer offenen Verbindung und sinkt nach Disconnect', async () => {
      const ws = await connect(port, SESSION_A);
      expect(getActiveWsConnectionCount()).toBeGreaterThanOrEqual(1);
      await disconnect(ws);
      expect(getActiveWsConnectionCount()).toBe(0);
    });

    it('zählt mehrere Verbindungen in derselben Session korrekt', async () => {
      const ws1 = await connect(port, SESSION_C);
      const ws2 = await connect(port, SESSION_C);
      expect(getActiveWsConnectionCount()).toBeGreaterThanOrEqual(2);
      await disconnect(ws1);
      await disconnect(ws2);
    });
  });

  // ── closeWebSocketServer ──────────────────────────────────────────────────────

  describe('closeWebSocketServer', () => {
    it('schließt alle offenen Verbindungen beim Shutdown', async () => {
      const ws = await connect(port, SESSION_A);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      await closeWebSocketServer();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });
  });

  // ── Persistenz (bindState / writeState) ──────────────────────────────────────

  describe('Persistenz (bindState / writeState)', () => {
    const SESSION_P = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

    beforeEach(() => {
      (db.query as jest.Mock).mockReset();
      (redis.getBuffer as jest.Mock).mockReset();
      (redis.set as jest.Mock).mockReset();
    });

    describe('bindState', () => {
      it('lädt Snapshot aus Redis wenn vorhanden — kein DB-Zugriff', async () => {
        const source = new Y.Doc();
        source.getText('content').insert(0, 'Hallo');
        const snapshot = Buffer.from(Y.encodeStateAsUpdate(source));
        (redis.getBuffer as jest.Mock).mockResolvedValueOnce(snapshot);

        const ydoc = new Y.Doc();
        await bindStateHandler(SESSION_P, ydoc);

        expect(redis.getBuffer).toHaveBeenCalledWith(`session:${SESSION_P}:snapshot`);
        expect(db.query).not.toHaveBeenCalled();
      });

      it('fällt auf PostgreSQL zurück wenn Redis leer ist', async () => {
        const source = new Y.Doc();
        const snapshot = Buffer.from(Y.encodeStateAsUpdate(source));
        (redis.getBuffer as jest.Mock).mockResolvedValueOnce(null);
        (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ content_snapshot: snapshot }] });

        const ydoc = new Y.Doc();
        await bindStateHandler(SESSION_P, ydoc);

        expect(db.query).toHaveBeenCalledWith(
          expect.stringContaining('content_snapshot'),
          [SESSION_P]
        );
        // Nach DB-Laden: in Redis cachen damit der nächste Aufruf schneller ist
        expect(redis.set).toHaveBeenCalledWith(
          `session:${SESSION_P}:snapshot`,
          snapshot,
          'EX',
          expect.any(Number)
        );
      });

      it('startet mit leerem Dokument wenn kein Snapshot existiert', async () => {
        (redis.getBuffer as jest.Mock).mockResolvedValueOnce(null);
        (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

        const ydoc = new Y.Doc();
        await bindStateHandler(SESSION_P, ydoc);

        // Kein Snapshot → kein Cachen nötig
        expect(redis.set).not.toHaveBeenCalled();
      });
    });

    describe('writeState', () => {
      it('speichert Snapshot in Redis und PostgreSQL gleichzeitig', async () => {
        (db.query as jest.Mock).mockResolvedValue({ rows: [] });

        const ydoc = new Y.Doc();
        await writeStateHandler(SESSION_P, ydoc);

        expect(redis.set).toHaveBeenCalledWith(
          `session:${SESSION_P}:snapshot`,
          expect.any(Buffer),
          'EX',
          expect.any(Number)
        );
        expect(db.query).toHaveBeenCalledWith(
          expect.stringContaining('ON CONFLICT'),
          expect.arrayContaining([SESSION_P])
        );
      });

      it('aktualisiert den geteilten Auto-Stand beim Disconnect', async () => {
        (db.query as jest.Mock).mockResolvedValue({ rows: [] });

        const ydoc = new Y.Doc();
        ydoc.getText('content').insert(0, 'SELECT 1');
        await writeStateHandler(SESSION_P, ydoc);

        expect(upsertAutoVersion).toHaveBeenCalledWith(SESSION_P, 'system', expect.any(String), 'session', expect.anything());
      });
    });
  });
});
