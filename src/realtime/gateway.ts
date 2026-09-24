import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeAwarenessUpdate } from 'y-protocols/awareness';

import type { Actor } from '../model/actor.ts';
import { mayOpenWorkpiece } from '../auth/access.ts';
import { workpieceExists } from '../db/collections/workpieces.ts';
import { asObjectId } from '../utils/input.ts';
import type { Connection, WorkpieceHub, OpenWorkpiece } from './hub.ts';
import { encodeAwareness, encodeSyncStep1, handleMessage } from './sync.ts';

/** The client announces two subprotocols: this marker and the token itself. */
const BEARER = 'bearer';

export interface GatewayOptions {
  readonly server: Server;
  readonly db: Db;
  readonly hub: WorkpieceHub;
  readonly checkToken: (token: string) => Actor;
  readonly logger: Logger;
  /** Left out during development, which lets every origin in. */
  readonly allowedOrigins?: readonly string[];
  /** Path prefix of the WebSocket address, the workpiece key follows it. */
  readonly path?: string;
}

export interface Gateway {
  /** How many connections currently hold this workpiece open. */
  countFor(workpieceId: string): number;
  close(): Promise<void>;
}

interface Opened {
  readonly workpieceId: ObjectId;
  readonly actor: Actor;
}

/**
 * Takes WebSocket connections and keeps them per workpiece. A refusal is answered
 * during the upgrade, so the client reads a plain HTTP status instead of a connection
 * that opens and dies without a word.
 */
export function attachGateway(options: GatewayOptions): Gateway {
  const prefix = options.path ?? '/ws/';
  const sockets = new Set<WebSocket>();

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
        void welcome(ws, opened, options, sockets);
      });
    })();
  };

  options.server.on('upgrade', onUpgrade);

  return {
    countFor: (workpieceId) => options.hub.count(workpieceId),
    close: async () => {
      options.server.off('upgrade', onUpgrade);
      for (const ws of sockets) {
        ws.close(1001, 'server shutting down');
      }
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await options.hub.close();
    },
  };
}

/**
 * Hands the fresh socket to the workpiece it asked for and starts the exchange. The
 * service opens with "this is what I have", the client answers with what it is missing.
 */
async function welcome(
  ws: WebSocket,
  opened: Opened,
  options: GatewayOptions,
  sockets: Set<WebSocket>,
): Promise<void> {
  const key = opened.workpieceId.toHexString();
  const connection: Connection = {
    actor: opened.actor,
    send: (message) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    },
  };

  sockets.add(ws);

  // Listeners go up before the workpiece is loaded. A client may send its first message
  // the instant the handshake succeeds, and an event without a listener is simply lost.
  const state: { open?: OpenWorkpiece; left: boolean } = { left: false };
  const waiting: Uint8Array[] = [];

  const apply = (open: OpenWorkpiece, data: Uint8Array): void => {
    const reply = handleMessage(
      { doc: open.doc, awareness: open.awareness, origin: connection },
      data,
    );
    if (reply !== undefined) {
      connection.send(reply);
    }
  };

  ws.on('message', (data: Buffer) => {
    const bytes = new Uint8Array(data);
    if (state.open === undefined) {
      waiting.push(bytes);
      return;
    }
    apply(state.open, bytes);
  });

  ws.on('close', () => {
    state.left = true;
    sockets.delete(ws);
    void options.hub.leave(opened.workpieceId, connection);
    options.logger.info({ workpieceId: key }, 'connection closed');
  });

  let open: OpenWorkpiece;
  try {
    open = await options.hub.join(opened.workpieceId, connection);
  } catch (error) {
    options.logger.error({ error, workpieceId: key }, 'could not open the workpiece');
    ws.close(1011, 'workpiece could not be opened');
    sockets.delete(ws);
    return;
  }

  if (state.left) {
    // Gone again while the workpiece was still loading.
    await options.hub.leave(opened.workpieceId, connection);
    return;
  }

  options.logger.info({ workpieceId: key, actorId: opened.actor.actorId }, 'connection open');

  connection.send(encodeSyncStep1(open.doc));

  const others = [...open.awareness.getStates().keys()];
  if (others.length > 0) {
    connection.send(encodeAwareness(encodeAwarenessUpdate(open.awareness, others)));
  }

  state.open = open;
  for (const data of waiting) {
    apply(open, data);
  }
  waiting.length = 0;
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

  const workpieceId = asObjectId(path.slice(prefix.length).split('?')[0]);
  if (workpieceId === undefined) {
    return { status: 400, text: 'Bad Request', reason: 'malformed workpiece key' };
  }

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

  if (!(await workpieceExists(options.db, workpieceId))) {
    return { status: 404, text: 'Not Found', reason: 'unknown workpiece' };
  }

  if (!(await mayOpenWorkpiece({ db: options.db, actor, workpieceId }))) {
    return { status: 403, text: 'Forbidden', reason: 'not allowed to open' };
  }

  return { workpieceId, actor };
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
