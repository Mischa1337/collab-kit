// D2 — End-to-End-Test für das WS-Schreib-Gating (N1c).
// Fährt eine ECHTE ws-Verbindung gegen die reale y-websocket-Maschinerie:
//   - Editor-Pfad (setupWSConnection)        → eingehendes Yjs-Update WIRD angewendet
//   - Read-only-Pfad (setupReadonlyConnection) → eingehendes Yjs-Update wird VERWORFEN
// Kein Controller-Import → kein setPersistence → keine DB/Redis nötig (isolierte y-websocket-Docs).
import http from 'http';
import { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { setupWSConnection, docs } from 'y-websocket/bin/utils';
import { setupReadonlyConnection } from '../services/websocket/readonly';

// y-protocol-Nachricht „Sync/Update" von Hand bauen (messageSync=0, messageYjsUpdate=2, dann varUint-Länge + Bytes).
function writeVarUint(arr: number[], num: number): void {
  let n = num;
  while (n > 127) { arr.push(128 | (n & 127)); n >>>= 7; }
  arr.push(n & 127);
}
function syncUpdateMessage(update: Uint8Array): Uint8Array {
  const out: number[] = [];
  writeVarUint(out, 0); // messageSync
  writeVarUint(out, 2); // messageYjsUpdate
  writeVarUint(out, update.length);
  return Uint8Array.from([...out, ...update]);
}

// Ein Yjs-Update, das 'hi' in getText('content') einfügt.
function helloUpdate(): Uint8Array {
  const d = new Y.Doc();
  d.getText('content').insert(0, 'hi');
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

describe('D2 — WS-Schreib-Gating (E2E)', () => {
  let server: http.Server;
  let port: number;
  const clients: WebSocket[] = [];

  beforeAll((done) => {
    server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (conn, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const docName = url.pathname.slice(1);
      if (url.searchParams.get('mode') === 'readonly') {
        setupReadonlyConnection(conn, req, docName);
      } else {
        setupWSConnection(conn, req, { docName, gc: true });
      }
    });
    server.listen(0, () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    clients.forEach((c) => c.close());
    server.close(done);
  });

  it('Editor: eingehendes Yjs-Update wird angewendet', async () => {
    const ws = await openClient(`ws://localhost:${port}/edit-room?mode=edit`);
    clients.push(ws);
    ws.send(syncUpdateMessage(helloUpdate()));
    const applied = await waitFor(() => docs.get('edit-room')?.getText('content').toString() === 'hi');
    expect(applied).toBe(true);
  });

  it('Viewer/Reviewer (read-only): eingehendes Yjs-Update wird VERWORFEN', async () => {
    const ws = await openClient(`ws://localhost:${port}/view-room?mode=readonly`);
    clients.push(ws);
    ws.send(syncUpdateMessage(helloUpdate()));
    // Negativ-Assertion: kurz warten, dann muss das Server-Doc weiterhin leer sein.
    await new Promise((r) => setTimeout(r, 300));
    expect(docs.get('view-room')?.getText('content').toString() ?? '').toBe('');
  });
});
