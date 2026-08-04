// N1 (Erweiterung) — WS-Schreib-Gating für read-only-Rollen (spectator/commentator).
// y-websocket richtet die Verbindung vollständig ein (Sync-Empfang + Awareness);
// wir ersetzen danach nur den message-Listener durch einen Filter, der eingehende
// SCHREIB-Updates verwirft. So bleibt „read-only" serverseitig erzwungen — nicht
// über einen direkten WS-Client umgehbar.
import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { setupWSConnection } from 'y-websocket/bin/utils';
import { logger } from '../../config/logger';

// y-protocol Nachrichtentypen: 0 = sync, 1 = awareness.
// sync-Subtyp: 0 = SyncStep1 (Leseanfrage), 1 = SyncStep2, 2 = Update.
// Schreibend sind nur sync/SyncStep2 und sync/Update; alles andere (step1, awareness) ist lesend/ok.
export function isWriteMessage(data: ArrayBuffer | Uint8Array | Buffer): boolean {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (buf.length < 2) return false;
  if (buf[0] !== 0) return false; // nur sync trägt Schreiboperationen
  return buf[1] === 1 || buf[1] === 2; // SyncStep2 oder Update
}

/**
 * Wie setupWSConnection, aber für Rollen ohne Editierrecht: eingehende Yjs-Schreib-Updates
 * werden serverseitig verworfen. Sync-Empfang (initialer Stand + fremde Updates) und Awareness
 * (eigener Cursor sichtbar) bleiben erlaubt.
 */
export function setupReadonlyConnection(ws: WebSocket, request: IncomingMessage, sessionId: string): void {
  setupWSConnection(ws, request, { docName: sessionId, gc: true });

  // y-websocket hat synchron seinen message-Listener registriert — diesen durch einen Filter ersetzen.
  const original = ws.listeners('message') as Array<(...args: unknown[]) => void>;
  if (original.length === 0) {
    // Fail-closed: lieber die Verbindung schließen als ungefiltert schreiben lassen.
    logger.error({ sessionId }, '[WS] Read-only: kein message-Listener gefunden — Verbindung geschlossen');
    ws.close(1011, 'readonly setup failed');
    return;
  }
  ws.removeAllListeners('message');
  for (const orig of original) {
    ws.on('message', (data: Buffer | ArrayBuffer, ...rest: unknown[]) => {
      if (isWriteMessage(data)) return; // viewer/reviewer dürfen das Dokument nicht ändern
      orig.call(ws, data, ...rest);
    });
  }
}
