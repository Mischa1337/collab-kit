declare module 'y-websocket/bin/utils' {
  import { WebSocket } from 'ws';
  import { IncomingMessage } from 'http';
  import { Doc } from 'yjs';

  export function setupWSConnection(
    conn: WebSocket,
    req: IncomingMessage,
    opts?: { docName?: string; gc?: boolean }
  ): void;

  export function setPersistence(persistence: {
    bindState: (docName: string, ydoc: Doc) => Promise<void>;
    writeState: (docName: string, ydoc: Doc) => Promise<void>;
    provider: unknown;
  } | null): void;

  /** Alle aktuell geladenen Y.Docs (docName → Doc). */
  export const docs: Map<string, Doc>;
}
