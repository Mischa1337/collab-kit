import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { ObjectId, type Db } from 'mongodb';
import type { Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';

import { mayOpenDocument } from '../auth/access.ts';
import type { Actor } from '../auth/token.ts';

/** The client announces two subprotocols: this marker and the token itself. */
const BEARER = 'bearer';

export interface GatewayOptions {
  readonly server: Server;
  readonly db: Db;
  readonly checkToken: (token: string) => Actor;
  readonly logger: Logger;
  /** Left out during development, which lets every origin in. */
  readonly allowedOrigins?: readonly string[];
  /** Path prefix of the WebSocket address, the document key follows it. */
  readonly path?: string;
}

export interface Gateway {
  /** How many connections currently hold this document open. */
  countFor(documentId: string): number;
  close(): Promise<void>;
}

interface Opened {
  readonly documentId: ObjectId;
  readonly actor: Actor;
}

/**
 * Takes WebSocket connections and keeps them per document. A refusal is answered
 * during the upgrade, so the client reads a plain HTTP status instead of a connection
 * that opens and dies without a word.
 */
export function attachGateway(options: GatewayOptions): Gateway {
  const prefix = options.path ?? '/ws/';
  const sockets = new Map<string, Set<WebSocket>>();

  const wss = new WebSocketServer({
    noServer: true,
    // Only the marker is echoed back. Echoing the token would put it into logs again.
    handleProtocols: (protocols) => (protocols.has(BEARER) ? BEARER : false),
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void (async () => {
      const opened = await admit(request, options, prefix);

      if ('status' in opened) {
        options.logger.info({ status: opened.status, reason: opened.reason }, 'upgrade refused');
        socket.write(`HTTP/1.1 ${opened.status} ${opened.text}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const key = opened.documentId.toHexString();
        const forDocument = sockets.get(key) ?? new Set<WebSocket>();
        forDocument.add(ws);
        sockets.set(key, forDocument);

        options.logger.info({ documentId: key, actorId: opened.actor.actorId }, 'connection open');

        ws.on('close', () => {
          forDocument.delete(ws);
          if (forDocument.size === 0) {
            sockets.delete(key);
          }
          options.logger.info({ documentId: key }, 'connection closed');
        });
      });
    })();
  };

  options.server.on('upgrade', onUpgrade);

  return {
    countFor: (documentId) => sockets.get(documentId)?.size ?? 0,
    close: async () => {
      options.server.off('upgrade', onUpgrade);
      for (const forDocument of sockets.values()) {
        for (const ws of forDocument) {
          ws.close(1001, 'server shutting down');
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

interface Refused {
  readonly status: number;
  readonly text: string;
  readonly reason: string;
}

/** Decides whether a handshake may proceed, in the order that leaks the least. */
async function admit(
  request: IncomingMessage,
  options: GatewayOptions,
  prefix: string,
): Promise<Opened | Refused> {
  if (!isAllowedOrigin(request.headers.origin, options.allowedOrigins)) {
    return { status: 403, text: 'Forbidden', reason: 'origin not allowed' };
  }

  const path = request.url ?? '';
  if (!path.startsWith(prefix)) {
    return { status: 404, text: 'Not Found', reason: 'unknown path' };
  }

  const raw = path.slice(prefix.length).split('?')[0] ?? '';
  if (!ObjectId.isValid(raw)) {
    return { status: 400, text: 'Bad Request', reason: 'malformed document key' };
  }
  const documentId = new ObjectId(raw);

  const token = readToken(request);
  if (token === undefined) {
    return { status: 401, text: 'Unauthorized', reason: 'no token offered' };
  }

  let actor: Actor;
  try {
    actor = options.checkToken(token);
  } catch {
    return { status: 401, text: 'Unauthorized', reason: 'token rejected' };
  }

  const current = await options.db
    .collection('documents')
    .findOne({ documentId, isCurrent: true }, { projection: { _id: 1 } });

  if (current === null) {
    return { status: 404, text: 'Not Found', reason: 'unknown document' };
  }

  if (!(await mayOpenDocument({ db: options.db, actor, documentId }))) {
    return { status: 403, text: 'Forbidden', reason: 'not allowed to open' };
  }

  return { documentId, actor };
}

function isAllowedOrigin(origin: string | undefined, allowed?: readonly string[]): boolean {
  if (allowed === undefined) {
    return true;
  }
  return origin !== undefined && allowed.includes(origin);
}

/** Reads the token from Sec-WebSocket-Protocol, where a browser can put it. */
function readToken(request: IncomingMessage): string | undefined {
  const offered = request.headers['sec-websocket-protocol'];
  if (offered === undefined) {
    return undefined;
  }

  return (Array.isArray(offered) ? offered.join(',') : offered)
    .split(',')
    .map((part) => part.trim())
    .find((part) => part !== '' && part !== BEARER);
}
