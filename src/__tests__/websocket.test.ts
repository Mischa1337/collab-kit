// M5 — WebSocket Server Tests
// Prüft Verbindungsaufbau, URL-Routing und Redis-Tracking (SADD/SREM).
// Startet einen echten HTTP-Server auf einem zufälligen Port — kein Docker nötig, da Redis und DB gemockt sind.
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import { app } from '../app';
import { setupWebSocketServer } from '../services/websocket/controller';
import { redis } from '../config/redis';

// Gültige UUIDs — M6 validiert das Format im upgrade-Handler.
const SESSION_1 = '11111111-1111-1111-1111-111111111111';
const SESSION_2 = '22222222-2222-2222-2222-222222222222';
const SESSION_3 = '44444444-4444-4444-4444-444444444444';
const SESSION_SHARED = '33333333-3333-3333-3333-333333333333';
const SESSION_5USERS = '55555555-5555-5555-5555-555555555555';

// DB mocken — M6 prüft ob die Session in der DB existiert.
jest.mock('../config/db', () => ({
  db: {
    query: jest.fn().mockResolvedValue({ rows: [{ id: 'mock-session' }] }),
  },
}));

// Redis-Methoden werden ersetzt — wir wollen nur prüfen ob sie korrekt aufgerufen werden.
jest.mock('../config/redis', () => ({
  redis: {
    publish: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    getBuffer: jest.fn().mockResolvedValue(null),
    scan: jest.fn().mockResolvedValue(['0', []]),
  },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  subscriber: {
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
  },
}));

// y-websocket Protokoll-Logik ausblenden — wir testen nur Routing und Redis, nicht das Yjs-Protokoll.
// setPersistence wird ebenfalls gemockt, da es beim Laden von controller.ts sofort aufgerufen wird (M6).
jest.mock('y-websocket/bin/utils', () => ({
  setupWSConnection: jest.fn(),
  setPersistence: jest.fn(),
}));

describe('M5 — WebSocket Server', () => {
  let server: Server;
  let port: number;

  // Vor allen Tests: echten HTTP-Server starten. Port 0 → Betriebssystem wählt freien Port automatisch.
  beforeAll((done) => {
    server = createServer(app);
    setupWebSocketServer(server);
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  // Nach allen Tests: Server sauber schließen, damit kein Port blockiert bleibt.
  afterAll((done) => {
    server.close(done);
  });

  // Basistest: Der Server muss WebSocket-Verbindungen auf /sync/:sessionId annehmen.
  it('nimmt WebSocket-Verbindung auf /sync/:sessionId an', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/sync/${SESSION_1}`);
    ws.on('open', () => {
      // readyState === 1 (OPEN) bedeutet: Verbindung steht und ist bereit für Nachrichten.
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      done();
    });
    ws.on('error', done);
  });

  // Sicherheitstest: Verbindungen auf anderen Pfaden müssen sofort abgewiesen werden.
  // Verhindert, dass beliebige WebSocket-Clients sich an den Server hängen.
  it('lehnt Verbindungen auf ungültigem Pfad ab', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/ungueltig`);
    // Bei abgewiesener Verbindung feuern 'error' und 'close' beide — finish verhindert done() zweimal.
    let finished = false;
    const finish = () => { if (!finished) { finished = true; done(); } };
    ws.on('close', finish);
    ws.on('error', finish);
  });

  // M4 UUID-Format-Validierung: /sync/<nicht-uuid> muss abgelehnt werden, auch wenn der Pfad stimmt.
  // Verhindert dass beliebige Strings als Session-ID durchkommen.
  it('lehnt Verbindungen auf /sync/ mit ungültigem UUID-Format ab', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/sync/not-a-uuid`);
    let finished = false;
    const finish = () => { if (!finished) { finished = true; done(); } };
    ws.on('close', finish);
    ws.on('error', finish);
  });

  // M5 Teil B: Beim Verbindungsaufbau muss der Nutzer in Redis eingetragen werden (SADD).
  // Damit ist er in der aktiven Nutzerliste sichtbar (GET /api/sessions/:id → active_users).
  it('schreibt Nutzer bei Connect in Redis (SADD)', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/sync/${SESSION_2}`);
    ws.on('open', () => {
      // Kurze Verzögerung: SADD ist async, wir warten bis der Aufruf abgeschlossen ist.
      setTimeout(() => {
        expect(redis.set as jest.Mock).toHaveBeenCalledWith(
          expect.stringContaining(`presence:${SESSION_2}:`),
          '1', 'EX', expect.any(Number)
        );
        ws.close();
        done();
      }, 50);
    });
    ws.on('error', done);
  });

  // M5 Teil B: Zwei Clients derselben Session → beide müssen separat in Redis eingetragen werden.
  // Sichert ab, dass die Nutzerliste bei mehreren gleichzeitigen Teilnehmern korrekt befüllt wird.
  it('trägt zwei Clients derselben Session separat in Redis ein', (done: jest.DoneCallback) => {
    const ws1 = new WebSocket(`ws://localhost:${port}/sync/${SESSION_SHARED}`);
    ws1.on('open', () => {
      const ws2 = new WebSocket(`ws://localhost:${port}/sync/${SESSION_SHARED}`);
      ws2.on('open', () => {
        setTimeout(() => {
          const presenceSets = (redis.set as jest.Mock).mock.calls
            .filter((c) => String(c[0]).startsWith(`presence:${SESSION_SHARED}:`));
          expect(presenceSets.length).toBe(2);
          ws1.close();
          ws2.close();
          done();
        }, 50);
      });
      ws2.on('error', done);
    });
    ws1.on('error', done);
  });

  // M5 Teil B: Beim Trennen muss der Nutzer aus Redis entfernt werden (SREM).
  // Verhindert "Geister-Nutzer" in der Nutzerliste nach dem Disconnect.
  it('entfernt Nutzer bei Disconnect aus Redis (SREM)', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/sync/${SESSION_3}`);
    ws.on('open', () => ws.close());
    ws.on('close', () => {
      setTimeout(() => {
        expect(redis.del as jest.Mock).toHaveBeenCalledWith(
          expect.stringContaining(`presence:${SESSION_3}:`)
        );
        done();
      }, 50);
    });
    ws.on('error', done);
  });

  // M13 Abnahmekriterium: 5 simultane Nutzer müssen gleichzeitig verbunden sein können.
  // Prüft dass alle 5 Verbindungen offen sind und jede separat in Redis eingetragen wird.
  it('hält 5 simultane WebSocket-Verbindungen und trägt alle in Redis ein', (done) => {
    const sockets: WebSocket[] = [];
    let openCount = 0;

    const onAllOpen = () => {
      setTimeout(() => {
        // Jeder Client muss genau einmal per SADD registriert worden sein.
        const presenceSets = (redis.set as jest.Mock).mock.calls
          .filter((c) => String(c[0]).startsWith(`presence:${SESSION_5USERS}:`));
        expect(presenceSets.length).toBe(5);
        sockets.forEach((ws) => ws.close());
        done();
      }, 50);
    };

    for (let i = 0; i < 5; i++) {
      const ws = new WebSocket(`ws://localhost:${port}/sync/${SESSION_5USERS}`);
      sockets.push(ws);
      ws.on('open', () => {
        openCount++;
        if (openCount === 5) onAllOpen();
      });
      ws.on('error', done);
    }
  });

});
