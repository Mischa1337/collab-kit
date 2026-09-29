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
import { encodeAwareness, encodeSyncStep1, handleMessage, MessageRefused } from './protocol.ts';

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
  /** How often every connection is pinged; silent until the next round means gone. 30 s. */
  readonly heartbeatMs?: number;
  /** Largest message taken, well below the 16 MiB MongoDB keeps in one document. 8 MiB. */
  readonly maxMessageBytes?: number;
  /** Largest awareness update, which goes to everyone every 15 s. 64 KiB. */
  readonly maxAwarenessBytes?: number;
  /** How long the shutdown waits for a client to answer before cutting it off. 5 s. */
  readonly shutdownGraceMs?: number;
}

export interface Gateway {
  /** How many connections currently hold this workpiece open. */
  countFor(workpieceId: ObjectId): number;
  /** Asks access.ts again for every open connection, after a route took access away. */
  recheck(): Promise<void>;
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

  // No port of its own: the HTTP server hands every upgrade over.
  const wss = new WebSocketServer({
    noServer: true,
    // Only the marker is echoed back. Echoing the token would put it into logs again.
    handleProtocols: (protocols) => (protocols.has(BEARER) ? BEARER : false),
    // Anything larger closes with 1009 before it reaches the workpiece.
    maxPayload: options.maxMessageBytes ?? 8 * 1024 * 1024,
  });

  // Answered since the last round; a closed laptop says no goodbye, and proxies drop silence.
  const answered = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!answered.has(ws)) {
        ws.terminate();
        continue;
      }
      answered.delete(ws);
      ws.ping();
    }
  }, options.heartbeatMs ?? 30_000);

  // Who each connection was let in as, so the question can be asked again later.
  const admissionOf = new WeakMap<WebSocket, Admitted>();

  // Checks every upgrade first, then refuses it with a status or lets ws complete it.
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Until ws takes over nobody listens, and a dropped connection must not end the service.
    const onSocketError = (error: Error): void => {
      options.logger.warn({ err: error }, 'connection lost during the handshake');
    };
    socket.on('error', onSocketError);

    void (async () => {
      const admission = await admit(request, options, prefix).catch((error: unknown): Refused => {
        options.logger.error({ err: error }, 'could not check the handshake');
        return { status: 500, text: 'Internal Server Error', reason: 'check failed' };
      });

      if ('status' in admission) {
        options.logger.info(
          { status: admission.status, reason: admission.reason },
          'upgrade refused',
        );
        socket.write(`HTTP/1.1 ${admission.status} ${admission.text}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }

      socket.off('error', onSocketError);
      wss.handleUpgrade(request, socket, head, (ws) => {
        admissionOf.set(ws, admission);
        answered.add(ws);
        ws.on('pong', () => answered.add(ws));
        void serveConnection(ws, admission, options).catch(
          logFailure(options.logger, 'connection failed'),
        );
      });
    })().catch(logFailure(options.logger, 'handshake failed'));
  };

  options.server.on('upgrade', onUpgrade);

  return {
    countFor: (workpieceId) => options.hub.count(workpieceId),
    // Whoever may no longer open their workpiece goes; the others do not notice.
    recheck: async () => {
      await Promise.all(
        Array.from(wss.clients, async (ws) => {
          const admitted = admissionOf.get(ws);
          if (admitted === undefined) {
            return;
          }

          try {
            if (!(await mayOpenWorkpiece(options.db, admitted.actor, admitted.workpieceId))) {
              options.logger.info(
                {
                  workpieceId: admitted.workpieceId.toHexString(),
                  actorId: admitted.actor.actorId,
                },
                'access withdrawn, connection closed',
              );
              ws.close(4403, 'access withdrawn');
            }
          } catch (error) {
            options.logger.error({ err: error }, 'could not check access again');
          }
        }),
      );
    },
    // Takes no new connections, closes the open ones, then lets go of the workpieces.
    close: async () => {
      options.server.off('upgrade', onUpgrade);
      clearInterval(heartbeat);
      for (const ws of wss.clients) {
        ws.close(1001, 'server shutting down');
      }

      // Whoever does not answer in time is cut off, so the shutdown ends before it is killed.
      const cutOff = setTimeout(() => {
        for (const ws of wss.clients) {
          ws.terminate();
        }
      }, options.shutdownGraceMs ?? 5000);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      clearTimeout(cutOff);

      await options.hub.close();
    },
  };
}

/** Serves one connection until it closes: listeners, loading, greeting, then every message. */
async function serveConnection(
  ws: WebSocket,
  admitted: Admitted,
  options: GatewayOptions,
): Promise<void> {
  // Every line this connection writes into the log says which workpiece and who.
  const log = options.logger.child({
    workpieceId: admitted.workpieceId.toHexString(),
    actorId: admitted.actor.actorId,
  });

  // What the hub knows of this socket: who is on it and how to reach them.
  const connection: Connection = {
    actor: admitted.actor,
    send: (message) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    },
    close: (code, reason) => ws.close(code, reason),
  };

  // Listeners before loading: a message may come right after the handshake and would be lost.
  const progress: { loaded?: OpenWorkpiece; left: boolean } = { left: false };
  const waiting: Uint8Array[] = [];

  // One message into the workpiece, and back the answer if the protocol asks for one.
  const receive = (workpiece: OpenWorkpiece, data: Uint8Array): void => {
    // Nothing more from a connection that is already being closed.
    if (ws.readyState !== ws.OPEN) {
      return;
    }

    try {
      const reply = handleMessage(
        {
          doc: workpiece.doc,
          awareness: workpiece.awareness,
          origin: connection,
          maxAwarenessBytes: options.maxAwarenessBytes ?? 64 * 1024,
          mayAnnounce: (clientId) => workpiece.mayAnnounce(connection, clientId),
        },
        data,
      );
      if (reply !== undefined) {
        connection.send(reply);
      }
    } catch (error) {
      // A refused or unusable message ends this connection, never the service.
      const refused = error instanceof MessageRefused;
      log.warn({ err: error }, 'message refused, connection closed');
      ws.close(refused ? error.closeCode : 1007, refused ? error.message : 'unusable message');
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

  // A frame against the rules or a lost socket: ws closes it, and the close listener leaves.
  ws.on('error', (error) => {
    log.warn({ err: error }, 'connection error');
  });

  ws.on('close', () => {
    progress.left = true;
    void options.hub
      .leave(admitted.workpieceId, connection)
      .catch(logFailure(log, 'could not leave the workpiece'));
    log.info('connection closed');
  });

  // Opens the workpiece, loading it from the database if nobody holds it yet.
  let workpiece: OpenWorkpiece;
  try {
    workpiece = await options.hub.join(admitted.workpieceId, connection);
  } catch (error) {
    log.error({ err: error }, 'could not open the workpiece');
    ws.close(1011, 'workpiece could not be opened');
    return;
  }

  // Gone again while it was loading; the close listener has already left.
  if (progress.left) {
    return;
  }

  log.info('connection open');

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

/** A catch for work nobody waits for: a failure is logged instead of ending the process. */
function logFailure(logger: Logger, message: string): (error: unknown) => void {
  return (error) => {
    logger.error({ err: error }, message);
  };
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
