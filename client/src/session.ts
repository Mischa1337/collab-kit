/** A session at one workpiece: one Y.Doc for its whole life, connected again and again. */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import {
  CollabKitError,
  type Closed,
  type CollabEvent,
  type Conflict,
  type Me,
  type Named,
  type OpenOptions,
  type Session,
  type SessionEvents,
  type Status,
} from './api.ts';
import { announce, presenceOf } from './presence.ts';
import { textOf, type OpenText } from './text.ts';

/** The client announces two subprotocols: this marker and the token itself. */
const BEARER = 'bearer';

/** Sent by CK alone: an event as it happens, to a connection opened with ?events=1. */
const MESSAGE_EVENT = 101;

/** Sent by the client alone: a fresh token over the open connection, before the old one runs out. */
const MESSAGE_TOKEN = 100;

/** How long before exp a fresh token is asked for. */
const RENEW_BEFORE_MS = 30_000;

/** Shortest wait between two asks, also when the tool has no fresh token yet. */
const RENEW_EVERY_MS = 5000;

/** Longest wait setTimeout holds; anything longer fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Close codes after which a new connection would end the same way. */
const FINAL_CODES: ReadonlySet<number> = new Set([4403, 1007, 1008, 1009]);

/** Longest wait between two attempts, as in y-websocket. */
const MAX_WAIT_MS = 2500;

/** What a session needs from the library around it. */
export interface SessionContext {
  /** The socket address without the workpiece key. */
  readonly socketUrl: string;
  readonly getToken: () => string | Promise<string>;
  /** Reads a route of CK with this token. */
  readonly read: <Answer>(
    token: string,
    path: string,
    query?: Record<string, string>,
  ) => Promise<Answer>;
}

/** Opens a session; it asks for token and rights before every connection, CK decides the rest. */
export function openSession<Value>(
  context: SessionContext,
  workpieceId: string,
  options: OpenOptions = {},
): Session<Value> {
  const doc = new Y.Doc();
  const mapName = options.map ?? 'units';
  const map = doc.getMap<Value>(mapName);
  // Own changes go in under tracked, or under untracked when kept out of undo.
  const tracked = Symbol('units');
  const untracked = Symbol('units, not undoable');
  // One step per update and only own ones, so undo never takes back the work of others.
  const history = new Y.UndoManager(map, { trackedOrigins: new Set([tracked]), captureTimeout: 0 });
  // Every text handed out, once per name.
  const texts = new Map<string, OpenText>();
  const provider = new WebsocketProvider(context.socketUrl, workpieceId, doc, {
    // Connected only once token and rights are in.
    connect: false,
    params: { events: '1' },
    // Two sessions in one browser meet at CK, never on a channel past it.
    disableBc: true,
    // Every close from CK comes back here, so the next attempt asks for token and rights again.
    shouldReconnect: () => false,
  });
  const { awareness } = provider;

  // The own value per key and the clocks its setting took, so a conflict can hand it back.
  const written = new Map<string, Written<Value>>();

  const listeners: {
    [Kind in keyof SessionEvents<Value>]: Set<(value: SessionEvents<Value>[Kind]) => void>;
  } = {
    status: new Set(),
    rightsChanged: new Set(),
    closed: new Set(),
    conflict: new Set(),
  };

  let status: Status = 'disconnected';
  let mayWrite = false;
  let rightsKnown = false;
  let me: Me | undefined;
  // Whether the session should be connected, and whether close ended it for good.
  let wanted = true;
  let ended = false;
  // Bumped by connect, disconnect, close and every end, so an attempt still under way stops.
  let generation = 0;
  // Attempts since the last sync, for the wait before the next one.
  let failures = 0;
  let renewedToken = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  // The token the connection last got, and the wait until a fresh one is asked for.
  let current: string | undefined;
  let renewal: ReturnType<typeof setTimeout> | undefined;

  let markSynced!: () => void;
  let failSynced!: (error: CollabKitError) => void;
  const synced = new Promise<void>((resolve, reject) => {
    markSynced = resolve;
    failSynced = reject;
  });
  // Nobody has to wait for it, so a session that ends early raises no unhandled rejection.
  synced.catch(() => undefined);

  /** Tells every listener; one that throws neither stops the others nor the session. */
  function emit<Kind extends keyof SessionEvents<Value>>(
    kind: Kind,
    value: SessionEvents<Value>[Kind],
  ): void {
    for (const listener of listeners[kind]) {
      try {
        listener(value);
      } catch (error) {
        setTimeout(() => {
          throw error;
        });
      }
    }
  }

  /** The own value a work-lost names, if this session set it through update and still knows it. */
  function lostIn(event: CollabEvent): Written<Value> | undefined {
    const own = lostRanges(event).filter((range) => range.client === doc.clientID);
    return [...written.values()].find((entry) =>
      own.some((range) => range.clock < entry.to && range.clock + range.length > entry.from),
    );
  }

  /** Notes where the connection stands and tells whoever listens, once per change. */
  function setStatus(next: Status): void {
    if (next !== status) {
      status = next;
      emit('status', next);
    }
  }

  /** Throws where CK would refuse a change, so nothing goes out that ends the session. */
  function checkWrite(): void {
    if (ended) {
      throw new CollabKitError(1000, 'session closed');
    }
    if (!mayWrite) {
      throw new CollabKitError(403, 'read only');
    }
  }

  /** Ends the connection until connect is called; the doc stays. */
  function end(closed: Closed): void {
    wanted = false;
    generation += 1;
    clearTimeout(retry);
    clearTimeout(renewal);
    provider.disconnect();
    setStatus('closed');
    failSynced(new CollabKitError(closed.code, closed.reason));
    emit('closed', closed);
  }

  /** Tries again after a wait that grows with every failure, as y-websocket does. */
  function later(): void {
    failures += 1;
    const attempting = generation;
    retry = setTimeout(() => void attempt(attempting), Math.min(100 * 2 ** failures, MAX_WAIT_MS));
  }

  /** One attempt: token and rights first, so a refusal is told and not hidden in a handshake. */
  async function attempt(attempting: number): Promise<void> {
    if (attempting !== generation) {
      return;
    }
    setStatus('connecting');

    let token: string;
    let rights: string[];
    try {
      token = await context.getToken();
      [rights, me] = await Promise.all([
        context.read<string[]>(token, '/me/rights', { kind: 'workpiece', id: workpieceId }),
        context.read<Me>(token, '/me'),
      ]);
    } catch (error) {
      if (attempting === generation) {
        refused(error, attempting);
      }
      return;
    }
    if (attempting !== generation) {
      return;
    }

    // Unknown or not allowed look the same, as at the handshake.
    if (!rights.includes('see')) {
      end({ code: 4403, reason: 'not allowed to open' });
      return;
    }
    renewedToken = false;

    // Told only when it changes, the first answer is no change.
    const writes = rights.includes('edit');
    const changed = rightsKnown && writes !== mayWrite;
    mayWrite = writes;
    rightsKnown = true;
    if (changed) {
      emit('rightsChanged', writes);
    }

    // Who this is, so the others see a person and not only a client.
    announce(awareness, me);

    provider.protocols = [BEARER, token];
    provider.connect();
    current = token;
    renewLater(token, expiryWait(token));
  }

  /** Asks for a fresh token after this wait; without one to wait for, never. */
  function renewLater(held: string, wait: number | undefined): void {
    clearTimeout(renewal);
    if (wait === undefined) {
      return;
    }
    renewal = setTimeout(() => void renew(held), Math.min(wait, MAX_TIMEOUT_MS));
  }

  /** Sends a fresh token over the open connection; the same one again means asking later. */
  async function renew(held: string): Promise<void> {
    const token = await Promise.resolve(context.getToken()).catch(() => held);
    // Closed or connected anew meanwhile, and a new connection asked for its own token.
    if (held !== current || !provider.wsconnected || provider.ws === null) {
      return;
    }
    if (token === held) {
      renewLater(held, RENEW_EVERY_MS);
      return;
    }

    // No answer comes; a refusal is CK closing the connection.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_TOKEN);
    encoding.writeVarString(encoder, token);
    provider.ws.send(encoding.toUint8Array(encoder));
    // So y-websocket, should it connect again by itself, offers the fresh one.
    provider.protocols = [BEARER, token];
    current = token;
    renewLater(token, expiryWait(token));
  }

  /** A call before connecting failed: unreachable tries again, a refusal of CK ends it. */
  function refused(error: unknown, attempting: number): void {
    if (!(error instanceof CollabKitError) || error.status >= 500) {
      later();
      return;
    }
    // A token may have run out between asking and calling, so once more with a fresh one.
    if (error.status === 401 && !renewedToken) {
      renewedToken = true;
      void attempt(attempting);
      return;
    }
    end({ code: 4000 + error.status, reason: error.message });
  }

  provider.on('status', ({ status: next }) => setStatus(next));
  provider.on('sync', (isSynced) => {
    if (isSynced) {
      failures = 0;
      markSynced();
    }
  });
  // Every close by CK, a refused handshake included, which a browser only shows as 1006.
  provider.on('closed', ({ code, reason }) => {
    // The next connection asks for a token of its own.
    clearTimeout(renewal);
    current = undefined;
    if (FINAL_CODES.has(code)) {
      end({ code, reason });
      return;
    }
    // 4409 among them: the next attempt asks for the rights and tells what changed.
    later();
  });

  provider.messageHandlers[MESSAGE_EVENT] = (_encoder, decoder) => {
    // Nothing goes into the encoder, or y-websocket would send it back.
    const event = JSON.parse(decoding.readVarString(decoder)) as Named<CollabEvent>;
    if (event.kind === 'work-lost') {
      emit('conflict', conflictOf(event, me?.actorId, lostIn(event)));
    }
  };

  void attempt(generation);

  return {
    workpieceId,
    synced,
    clientId: doc.clientID,
    get mayWrite() {
      return mayWrite;
    },
    get status() {
      return status;
    },
    units: {
      get: (key) => map.get(key),
      entries: () => [...map.entries()],
      update: ({ set = {}, delete: removed = [] }, { undoable = true } = {}) => {
        checkWrite();
        // One transaction, so CK gets one change and undo one step.
        doc.transact(
          () => {
            for (const key of removed) {
              map.delete(key);
              written.delete(key);
            }
            for (const [key, value] of Object.entries(set)) {
              // The clocks before and after are the pieces this value went into.
              const from = Y.getState(doc.store, doc.clientID);
              map.set(key, value);
              written.set(key, { from, to: Y.getState(doc.store, doc.clientID), value });
            }
          },
          undoable ? tracked : untracked,
        );
      },
      onChange: (listener) => {
        // Undo and redo are local too, but the editor does not show them yet.
        const observer = ({ keysChanged, transaction }: Y.YMapEvent<Value>): void =>
          listener([...keysChanged], !transaction.local || transaction.origin === history);
        map.observe(observer);
        return () => map.unobserve(observer);
      },
      undo: () => {
        checkWrite();
        return history.undo() !== null;
      },
      redo: () => {
        checkWrite();
        return history.redo() !== null;
      },
      canUndo: () => history.canUndo(),
      canRedo: () => history.canRedo(),
    },
    text: (name) => {
      if (ended) {
        throw new CollabKitError(1000, 'session closed');
      }
      const known = texts.get(name);
      if (known !== undefined) {
        return known.shared;
      }
      // A mistake of the tool, not a refusal of CK, so no status.
      if (name === mapName) {
        throw new Error(`${name} holds the units of this session, not a text`);
      }
      const opened = textOf(doc, doc.getText(name), workpieceId, checkWrite);
      texts.set(name, opened);
      return opened.shared;
    },
    presence: presenceOf(awareness, () => me?.actorId),
    on: (kind, listener) => {
      listeners[kind].add(listener);
      return () => listeners[kind].delete(listener);
    },
    disconnect: () => {
      if (ended || !wanted) {
        return;
      }
      wanted = false;
      generation += 1;
      clearTimeout(retry);
      clearTimeout(renewal);
      provider.disconnect();
      setStatus('disconnected');
    },
    connect: () => {
      if (ended || wanted) {
        return;
      }
      wanted = true;
      generation += 1;
      failures = 0;
      void attempt(generation);
    },
    yjs: { doc, awareness },
    close: () => {
      if (ended) {
        return;
      }
      ended = true;
      wanted = false;
      generation += 1;
      clearTimeout(retry);
      clearTimeout(renewal);
      failSynced(new CollabKitError(1000, 'session closed'));
      for (const set of Object.values(listeners)) {
        set.clear();
      }
      written.clear();
      // Each history listens to the doc until it is let go of; emptied first, so canUndo is false.
      for (const steps of [history, ...Array.from(texts.values(), (text) => text.history)]) {
        steps.clear();
        steps.destroy();
      }
      texts.clear();
      // The provider tells CK this client left; awareness and doc keep no timer behind.
      provider.destroy();
      awareness.destroy();
      doc.destroy();
      status = 'closed';
    },
  };
}

/** How long until a fresh token is asked for: shortly before exp, never sooner than the shortest wait. */
function expiryWait(token: string): number | undefined {
  const exp = expiryOf(token);
  return exp === undefined
    ? undefined
    : Math.max(exp * 1000 - RENEW_BEFORE_MS - Date.now(), RENEW_EVERY_MS);
}

/** The exp of a token, read without checking it, since only CK can; undefined without one. */
function expiryOf(token: string): number | undefined {
  try {
    // The payload is the middle part, base64url without padding.
    const payload = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const exp = (JSON.parse(atob(payload)) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

/** A value this session set through update, and the clocks of its own client it took. */
interface Written<Value> {
  readonly from: number;
  readonly to: number;
  readonly value: Value;
}

/** The stretches a work-lost names as lost; none when CK only counted them. */
function lostRanges(event: CollabEvent): { client: number; clock: number; length: number }[] {
  const lost = event.detail?.['lost'];
  if (!Array.isArray(lost)) {
    return [];
  }
  return lost.flatMap((range: unknown) => {
    if (typeof range !== 'object' || range === null) {
      return [];
    }
    const { client, clock, length } = range as Record<string, unknown>;
    return typeof client === 'number' && typeof clock === 'number' && typeof length === 'number'
      ? [{ client, clock, length }]
      : [];
  });
}

/** A work-lost event from the view of this person: the loser comes first in affects. */
function conflictOf<Value>(
  event: Named<CollabEvent>,
  self: string | undefined,
  lost: Written<Value> | undefined,
): Conflict<Value> {
  const loser = event.affects?.[0] ?? event.createdBy;
  const unit = event.anchor.unit;

  return {
    ...(unit === undefined ? {} : { unit }),
    cause: event.detail?.['cause'] as Conflict['cause'],
    loser,
    winner: event.createdBy,
    mine: loser === self,
    names: event.names ?? {},
    event,
    ...(lost === undefined ? {} : { lostValue: lost.value }),
  };
}
