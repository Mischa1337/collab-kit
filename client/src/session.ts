/** A session at one workpiece: one Y.Doc for its whole life, connected again and again. */

import * as decoding from 'lib0/decoding';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import {
  CollabKitError,
  type Closed,
  type CollabEvent,
  type Conflict,
  type Me,
  type OpenOptions,
  type Person,
  type PresenceClient,
  type Session,
  type SessionEvents,
  type Status,
} from './api.ts';

/** The client announces two subprotocols: this marker and the token itself. */
const BEARER = 'bearer';

/** Sent by CK alone: an event as it happens, to a connection opened with ?events=1. */
const MESSAGE_EVENT = 101;

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
  const map = doc.getMap<Value>(options.map ?? 'units');
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

  const listeners: { [Kind in keyof SessionEvents]: Set<(value: SessionEvents[Kind]) => void> } = {
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

  let markSynced!: () => void;
  let failSynced!: (error: CollabKitError) => void;
  const synced = new Promise<void>((resolve, reject) => {
    markSynced = resolve;
    failSynced = reject;
  });
  // Nobody has to wait for it, so a session that ends early raises no unhandled rejection.
  synced.catch(() => undefined);

  /** Tells every listener; one that throws neither stops the others nor the session. */
  function emit<Kind extends keyof SessionEvents>(kind: Kind, value: SessionEvents[Kind]): void {
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

  /** Notes where the connection stands and tells whoever listens, once per change. */
  function setStatus(next: Status): void {
    if (next !== status) {
      status = next;
      emit('status', next);
    }
  }

  /** Ends the connection until connect is called; the doc stays. */
  function end(closed: Closed): void {
    wanted = false;
    generation += 1;
    clearTimeout(retry);
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
    awareness.setLocalStateField(
      'person',
      me.label === undefined ? { id: me.actorId } : { id: me.actorId, name: me.label },
    );

    provider.protocols = [BEARER, token];
    provider.connect();
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
    if (FINAL_CODES.has(code)) {
      end({ code, reason });
      return;
    }
    // 4409 among them: the next attempt asks for the rights and tells what changed.
    later();
  });

  provider.messageHandlers[MESSAGE_EVENT] = (_encoder, decoder) => {
    // Nothing goes into the encoder, or y-websocket would send it back.
    const event = JSON.parse(decoding.readVarString(decoder)) as CollabEvent;
    if (event.kind === 'work-lost') {
      emit('conflict', conflictOf(event, me?.actorId));
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
      update: ({ set = {}, delete: removed = [] }) => {
        if (ended) {
          throw new CollabKitError(1000, 'session closed');
        }
        if (!mayWrite) {
          throw new CollabKitError(403, 'read only');
        }
        // One transaction, so CK gets one change.
        doc.transact(() => {
          for (const key of removed) {
            map.delete(key);
          }
          for (const [key, value] of Object.entries(set)) {
            map.set(key, value);
          }
        });
      },
      onChange: (listener) => {
        const observer = (event: Y.YMapEvent<Value>): void =>
          listener([...event.keysChanged], !event.transaction.local);
        map.observe(observer);
        return () => map.unobserve(observer);
      },
    },
    presence: {
      set: (fields) => {
        const own = awareness.getLocalState() ?? {};
        // person stays what GET /me said, whatever the fields bring.
        awareness.setLocalState({ ...own, ...fields, person: own['person'] });
      },
      people: () => peopleIn(awareness.getStates(), me?.actorId),
      onChange: (listener) => {
        const observer = (): void => listener();
        awareness.on('change', observer);
        return () => awareness.off('change', observer);
      },
    },
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
      failSynced(new CollabKitError(1000, 'session closed'));
      for (const set of Object.values(listeners)) {
        set.clear();
      }
      // The provider tells CK this client left; awareness and doc keep no timer behind.
      provider.destroy();
      awareness.destroy();
      doc.destroy();
      status = 'closed';
    },
  };
}

/** A work-lost event from the view of this person: the loser comes first in affects. */
function conflictOf(event: CollabEvent, self: string | undefined): Conflict {
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
  };
}

/** The awareness entries by person; an entry without one is a session not yet in. */
function peopleIn(
  states: Map<number, Record<string, unknown>>,
  self: string | undefined,
): Person[] {
  const people = new Map<string, Person & { clients: PresenceClient[] }>();

  for (const [clientId, state] of states) {
    const person = personIn(state['person']);
    if (person === undefined) {
      continue;
    }
    const entry = people.get(person.id) ?? { ...person, self: person.id === self, clients: [] };
    entry.clients.push({ clientId, state });
    people.set(person.id, entry);
  }
  return [...people.values()];
}

/** The person an entry names, if it names one the way the library writes it. */
function personIn(raw: unknown): { id: string; name?: string } | undefined {
  if (typeof raw !== 'object' || raw === null || !('id' in raw) || typeof raw.id !== 'string') {
    return undefined;
  }
  return 'name' in raw && typeof raw.name === 'string'
    ? { id: raw.id, name: raw.name }
    : { id: raw.id };
}
