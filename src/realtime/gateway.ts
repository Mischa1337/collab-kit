import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';

import type { Actor } from '../model/actor.ts';
import { mayOpenWorkpiece } from '../auth/access.ts';
import { workpieceExists } from '../db/collections/workpieces.ts';
import { asObjectId } from '../utils/input.ts';
import type { Connection, WorkpieceHub, OpenWorkpiece } from './hub.ts';
import { encodeAwareness, encodeSyncStep1, handleMessage } from './protocol.ts';

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
  /** Start of the WebSocket address, the workpiece key follows it; '/ws/' when left out. */
  readonly pathPrefix?: string;
}

export interface Gateway {
  /** How many connections currently hold this workpiece open. */
  countFor(workpieceId: ObjectId): number;
  close(): Promise<void>;
}

/** A handshake that may proceed: which workpiece, and who asks for it. */
interface Admitted {
  readonly workpieceId: ObjectId;
  readonly actor: Actor;
}

/** Takes WebSocket connections; a refusal is a plain HTTP status, not a socket that dies. */
export function attachGateway(options: GatewayOptions): Gateway {
  const prefix = options.pathPrefix ?? '/ws/';
  const sockets = new Set<WebSocket>();

  // No port of its own: the HTTP server hands every upgrade over.
  const wss = new WebSocketServer({
    noServer: true,
    // Only the marker is echoed back. Echoing the token would put it into logs again.
    handleProtocols: (protocols) => (protocols.has(BEARER) ? BEARER : false),
  });

  // Checks every upgrade first, then refuses it with a status or lets ws complete it.
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void (async () => {
      const admission = await admit(request, options, prefix);

      if ('status' in admission) {
        options.logger.info(
          { status: admission.status, reason: admission.reason },
          'upgrade refused',
        );
        socket.write(`HTTP/1.1 ${admission.status} ${admission.text}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        void serveConnection(ws, admission, options, sockets);
      });
    })();
  };

  options.server.on('upgrade', onUpgrade);

  return {
    countFor: (workpieceId) => options.hub.count(workpieceId),
    // Takes no new connections, closes the open ones, then lets go of the workpieces.
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

/** Serves one connection until it closes: listeners, loading, greeting, then every message. */
async function serveConnection(
  ws: WebSocket,
  admitted: Admitted,
  options: GatewayOptions,
  sockets: Set<WebSocket>,
): Promise<void> {
  // What the hub knows of this socket: who is on it and how to reach them.
  const connection: Connection = {
    actor: admitted.actor,
    send: (message) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    },
  };

  sockets.add(ws);

  // Listeners before loading: a message may come right after the handshake and would be lost.
  const progress: { loaded?: OpenWorkpiece; left: boolean } = { left: false };
  const waiting: Uint8Array[] = [];

  // One message into the workpiece, and back the answer if the protocol asks for one.
  const receive = (workpiece: OpenWorkpiece, data: Uint8Array): void => {
    const reply = handleMessage(
      { doc: workpiece.doc, awareness: workpiece.awareness, origin: connection },
      data,
    );
    if (reply !== undefined) {
      connection.send(reply);
    }
  };

  ws.on('message', (data: Buffer) => {
    const bytes = new Uint8Array(data);
    if (progress.loaded === undefined) {
      waiting.push(bytes);
      return;
    }
    receive(progress.loaded, bytes);
  });

  ws.on('close', () => {
    progress.left = true;
    sockets.delete(ws);
    void options.hub.leave(admitted.workpieceId, connection);
    options.logger.info({ workpieceId: admitted.workpieceId.toHexString() }, 'connection closed');
  });

  // Opens the workpiece, loading it from the database if nobody holds it yet.
  let workpiece: OpenWorkpiece;
  try {
    workpiece = await options.hub.join(admitted.workpieceId, connection);
  } catch (error) {
    options.logger.error(
      { error, workpieceId: admitted.workpieceId.toHexString() },
      'could not open the workpiece',
    );
    ws.close(1011, 'workpiece could not be opened');
    sockets.delete(ws);
    return;
  }

  if (progress.left) {
    // Gone again while the workpiece was still loading.
    await options.hub.leave(admitted.workpieceId, connection);
    return;
  }

  options.logger.info(
    { workpieceId: admitted.workpieceId.toHexString(), actorId: admitted.actor.actorId },
    'connection open',
  );

  // Greets with the state vector of the workpiece and with who else is there.
  connection.send(encodeSyncStep1(workpiece.doc));

  const others = [...workpiece.awareness.getStates().keys()];
  if (others.length > 0) {
    connection.send(encodeAwareness(workpiece.awareness, others));
  }

  // From here messages go straight in, after those that came while it was loading.
  progress.loaded = workpiece;
  for (const data of waiting) {
    receive(workpiece, data);
  }
  waiting.length = 0;
}

/** A handshake turned away: the status for the client, the reason for the log. */
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
): Promise<Admitted | Refused> {
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

  if (!(await mayOpenWorkpiece(options.db, actor, workpieceId))) {
    // The same answer as for an unknown one, so a handshake does not tell which keys exist.
    return { status: 404, text: 'Not Found', reason: 'not allowed to open' };
  }

  return { workpieceId, actor };
}

/** Without a list every origin passes, with one only those on it. */
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
