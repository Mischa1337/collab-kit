import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { WebSocket } from 'ws';
import * as Y from 'yjs';

/**
 * The client half of the Yjs protocol, just enough for the tests. It stands in for the
 * tool that docks later and proves the service speaks the standard exchange.
 */
const MESSAGE_SYNC = 0;
const REMOTE = Symbol('remote');

export interface TestClient {
  readonly doc: Y.Doc;
  /** Resolves once the service has sent everything this client was missing. */
  readonly synced: Promise<void>;
  close(): Promise<void>;
}

export function connectClient(url: string, protocols: string[]): Promise<TestClient> {
  const doc = new Y.Doc();
  const socket = new WebSocket(url, protocols);

  let markSynced!: () => void;
  const synced = new Promise<void>((resolve) => {
    markSynced = resolve;
  });

  const send = (message: Uint8Array): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(message);
    }
  };

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) {
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  });

  socket.on('message', (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const encoder = encoding.createEncoder();

    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) {
      return;
    }

    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    const kind = syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);

    if (kind === syncProtocol.messageYjsSyncStep2) {
      markSynced();
    }
    if (encoding.length(encoder) > 1) {
      send(encoding.toUint8Array(encoder));
    }
  });

  return new Promise((resolve, reject) => {
    socket.on('open', () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, doc);
      send(encoding.toUint8Array(encoder));

      resolve({
        doc,
        synced,
        close: () =>
          new Promise<void>((done) => {
            socket.on('close', () => done());
            socket.close();
          }),
      });
    });
    socket.on('error', reject);
  });
}

/** Waits for a condition instead of guessing how long the network needs. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  /* eslint-enable no-await-in-loop */

  return false;
}
