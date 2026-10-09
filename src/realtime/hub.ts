import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';

import type { Actor } from '../model/actor.ts';
import type { Anchor } from '../model/anchor.ts';
import { createActorNotes, type ActorNotes } from '../db/collections/actors.ts';
import { workpieceExists } from '../db/collections/workpieces.ts';
import { recordEvent, type EventRecord } from '../db/collections/events.ts';
import { creatorsOf, newestUpdateId } from '../db/collections/updates.ts';
import { eventKeysOf, withNames } from '../db/names.ts';
import { defined } from '../utils/optional.ts';
import {
  deleterOf,
  enqueue,
  foldNow,
  loadWorkpiece,
  storeUpdate,
  type Stored,
} from './persistence.ts';
import { encodeAwareness, encodeEvent, encodeSyncUpdate, SENDER_DELETES } from './protocol.ts';
import {
  containersOf,
  deletionsIn,
  idKey,
  lossEvents,
  removalEvents,
  type DeleteSet,
  type Deletions,
  type Loss,
  type Removal,
} from './removals.ts';

/** Key in transaction.meta for what the change deleted, read while it still could be. */
const DELETIONS = Symbol('deletions');

/** What a change without a sender deleted: nothing anybody needs to hear about. */
const NO_DELETIONS: Deletions = { removals: [], losses: [] };

/** What the hub needs from a connection, so it does not depend on the transport. */
export interface Connection {
  readonly actor: Actor;
  /** Whether it asked with ?events=1 to hear of events as they happen, as message 101. */
  readonly wantsEvents: boolean;
  send(message: Uint8Array): void;
  /** Ends the connection; a client that comes back syncs again from the stored state. */
  close(code: number, reason: string): void;
}

/** A workpiece while somebody holds it: its Y.Doc, who is present and who is connected. */
export interface OpenWorkpiece {
  readonly workpieceId: ObjectId;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly connections: Set<Connection>;
  /** Whether a connection may speak for an awareness client: never for another person's. */
  mayAnnounce(connection: Connection, clientId: number): boolean;
}

/** What a person gives a checkpoint: who sets it, a name and the why. */
export interface NewCheckpoint {
  readonly createdBy: string;
  readonly label?: string;
  readonly reason?: string;
}

/** What the gateway and the routes may ask of the hub. */
export interface WorkpieceHub {
  /** Adds a connection, loading the workpiece if it is the first. */
  join(workpieceId: ObjectId, connection: Connection): Promise<OpenWorkpiece>;
  /** Removes a connection and leaves a trace; the last one out closes the workpiece. */
  leave(workpieceId: ObjectId, connection: Connection): Promise<void>;
  /** Marks this state as worth coming back to; reason is the only place for the why. */
  checkpoint(workpieceId: ObjectId, input: NewCheckpoint): Promise<EventRecord>;
  /** How many connections hold this workpiece right now. */
  count(workpieceId: ObjectId): number;
  /** Lets go of every workpiece, for the shutdown. */
  close(): Promise<void>;
}

/** A workpiece the hub holds: its connections at once, the loaded workpiece once it is there. */
interface Held {
  readonly connections: Set<Connection>;
  readonly loaded: Promise<Loaded>;
}

/** One loaded workpiece: what is live, what is stored, and which awareness belongs to whom. */
interface Loaded {
  readonly workpiece: OpenWorkpiece;
  /** The stored side of the same workpiece: its queue and how far it is kept. */
  readonly stored: Stored;
  /** Which connection speaks for each awareness client; its entry goes when that one leaves. */
  readonly announcedBy: Map<number, Connection>;
  /** Whose pieces each Yjs client brought, filled only from the database, so both agree. */
  readonly authors: Map<number, string>;
}

/** What an awareness update reports: the client ids added, updated and removed. */
interface AwarenessChange {
  readonly added: number[];
  readonly updated: number[];
  readonly removed: number[];
}

export interface HubOptions {
  readonly db: Db;
  readonly logger: Logger;
  /** Changes that may pile up before folding again; only a matter of loading time. */
  readonly foldEvery?: number;
  /** Shared with the routes, so a name is written once; left out, the hub keeps its own. */
  readonly noteActor?: ActorNotes;
}

/** Keeps one Y.Doc per open workpiece, passes changes on and keeps traces of who was there. */
export function createWorkpieceHub(options: HubOptions): WorkpieceHub {
  const foldEvery = options.foldEvery ?? 400;
  const noteActor = options.noteActor ?? createActorNotes(options.db, options.logger);
  // Every held workpiece by its hex key; counting never has to wait for it to load.
  const heldByKey = new Map<string, Held>();
  // Closed for everyone after a change could not be stored; nothing more is done with them.
  const discarded = new WeakSet<Loaded>();
  // Leaves still being written; close waits for them, so everyone connected gets a left.
  const leaving = new Set<Promise<void>>();

  /** Loads the workpiece and wires its Y.Doc and awareness to this hub. */
  async function load(workpieceId: ObjectId, connections: Set<Connection>): Promise<Loaded> {
    const { doc, stored, units } = await loadWorkpiece(options.db, workpieceId);
    const announcedBy = new Map<number, Connection>();
    // Where the tool keeps its units, so each conflict hangs on the unit it hit.
    const containers = containersOf(units);

    // The service is nobody in the room, so it holds no presence of its own.
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);

    const loaded: Loaded = {
      workpiece: {
        workpieceId,
        doc,
        awareness,
        connections,
        // The same person may take their client over, as after a network change.
        mayAnnounce: (connection, clientId) => {
          const speaker = announcedBy.get(clientId);
          return speaker === undefined || speaker.actor.actorId === connection.actor.actorId;
        },
      },
      stored,
      announcedBy,
      authors: new Map(),
    };

    // Before Yjs collects what was deleted, while each piece still knows where it sat.
    doc.on('afterTransaction', (transaction: Y.Transaction) => {
      const known = transaction.meta.get(SENDER_DELETES) as DeleteSet | undefined;
      if (known !== undefined) {
        transaction.meta.set(DELETIONS, deletionsIn(transaction, known, containers));
      }
    });

    // Attached only now: replaying the stored history must not store it a second time.
    doc.on(
      'update',
      (update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
        const deletions =
          (transaction.meta.get(DELETIONS) as Deletions | undefined) ?? NO_DELETIONS;
        onUpdate(loaded, update, origin, deletions);
      },
    );

    // Awareness is passed on like an update, but never stored.
    loaded.workpiece.awareness.on('update', (change: AwarenessChange, origin: unknown) => {
      onAwareness(loaded, change, origin);
    });

    return loaded;
  }

  /** Writes an event of the service; a failure is only logged, a trace may never break work. */
  async function trace(workpieceId: ObjectId, kind: string, createdBy: string, at?: ObjectId) {
    try {
      await recordEvent(options.db, {
        kind,
        createdBy,
        anchor: anchorOf(workpieceId),
        ...defined({ at }),
      });
    } catch (error) {
      options.logger.error(
        { err: error, kind, workpieceId: workpieceId.toHexString() },
        'could not keep the trace, the work carries on without it',
      );
    }
  }

  /** Leaves the trace joined or left and keeps the name of the person; neither fails the caller. */
  async function notePresence(
    workpieceId: ObjectId,
    kind: 'joined' | 'left',
    actor: Actor,
    at?: ObjectId,
  ): Promise<void> {
    await Promise.all([trace(workpieceId, kind, actor.actorId, at), noteActor(actor)]);
  }

  /** Whose pieces these clients brought; asked of the database once, remembered from then on. */
  async function authorsOf(
    loaded: Loaded,
    clients: readonly number[],
  ): Promise<ReadonlyMap<number, string>> {
    const workpieceId = loaded.workpiece.workpieceId;
    const missing = [...new Set(clients)].filter((client) => !loaded.authors.has(client));
    if (missing.length > 0) {
      for (const [client, author] of await creatorsOf(options.db, workpieceId, missing)) {
        loaded.authors.set(client, author);
      }
    }

    // Whose author no stored change names stays out of the events.
    const unknown = missing.filter((client) => !loaded.authors.has(client));
    if (unknown.length > 0) {
      options.logger.warn(
        { workpieceId: workpieceId.toHexString(), clients: unknown },
        'deleted pieces whose author no stored change names, left out',
      );
    }
    return loaded.authors;
  }

  /** Tells whose work a change removed or replaced; a failure is only logged, like any trace. */
  async function traceRemovals(
    loaded: Loaded,
    removals: readonly Removal[],
    createdBy: string,
    at: ObjectId,
  ): Promise<void> {
    const workpieceId = loaded.workpiece.workpieceId;

    try {
      const authors = await authorsOf(
        loaded,
        removals.map((removal) => removal.client),
      );
      const events = removalEvents(removals, authors, {
        createdBy,
        anchor: anchorOf(workpieceId),
        at,
      });
      await Promise.all(events.map((event) => recordEvent(options.db, event)));
    } catch (error) {
      options.logger.error(
        { err: error, workpieceId: workpieceId.toHexString() },
        'could not tell whose work was removed, the work carries on without it',
      );
    }
  }

  /** Tells who lost work to whom, at once to whoever asked; a failure is only logged. */
  async function traceLosses(
    loaded: Loaded,
    losses: readonly Loss[],
    sender: string,
    at: ObjectId,
  ): Promise<void> {
    const workpieceId = loaded.workpiece.workpieceId;

    try {
      // Whose the lost pieces are, and whose the values that took their keys.
      const authors = await authorsOf(
        loaded,
        losses.flatMap((loss) =>
          loss.cause === 'overwritten' ? [loss.client, loss.other.client] : [loss.client],
        ),
      );

      // Who deleted each place: the sender, if this change did, else whoever stored it.
      const places = new Map(
        losses
          .filter((loss) => loss.cause === 'place-removed')
          .map((loss) => [idKey(loss.other), loss]),
      );
      const deleters = new Map<string, string>();
      await Promise.all(
        [...places].map(async ([key, loss]) => {
          const deleter = loss.removedNow
            ? sender
            : await deleterOf(options.db, workpieceId, loss.other);
          if (deleter !== undefined) {
            deleters.set(key, deleter);
          }
        }),
      );

      const events = lossEvents(losses, authors, deleters, {
        anchor: anchorOf(workpieceId),
        at,
        sender,
      });
      await Promise.all(
        events.map(async (event) => {
          const record = await recordEvent(options.db, event);
          // Only what is written goes out, so nobody hears of an event that is nowhere kept.
          notify(loaded.workpiece, encodeEvent(await withNames(options.db, record, eventKeysOf)));
        }),
      );
    } catch (error) {
      options.logger.error(
        { err: error, workpieceId: workpieceId.toHexString() },
        'could not tell whose work was lost, the work carries on without it',
      );
    }
  }

  /** Stores first, distributes second: nobody shall see a change that is nowhere kept. */
  function onUpdate(
    loaded: Loaded,
    update: Uint8Array,
    origin: unknown,
    deletions: Deletions,
  ): void {
    const from = asConnection(origin);

    // In the queue, so changes are stored in the order they arrived.
    void enqueue(loaded.stored, async () => {
      // Closed after a failed store: the clients bring their changes back when they return.
      if (discarded.has(loaded)) {
        return;
      }
      if (from === undefined) {
        throw new Error('a change arrived without a connection to attribute it to');
      }

      let updateId: ObjectId;
      try {
        updateId = await storeUpdate(options.db, loaded.stored, update, from.actor.actorId);
      } catch (error) {
        options.logger.error(
          { err: error, workpieceId: loaded.workpiece.workpieceId.toHexString() },
          'a change could not be stored, so everyone is disconnected and the workpiece reloads',
        );
        await discard(loaded);
        return;
      }
      broadcast(loaded.workpiece, encodeSyncUpdate(update), from);

      // Only once stored and passed on, so telling of it never holds up the work.
      if (deletions.removals.length > 0) {
        await traceRemovals(loaded, deletions.removals, from.actor.actorId, updateId);
      }
      if (deletions.losses.length > 0) {
        await traceLosses(loaded, deletions.losses, from.actor.actorId, updateId);
      }

      // Now and then, so the next load does not replay the whole history.
      if (loaded.stored.updatesSinceFoldAttempt >= foldEvery) {
        await tryFold(loaded);
      }
    }).catch((error: unknown) => {
      options.logger.error(
        { err: error, workpieceId: loaded.workpiece.workpieceId.toHexString() },
        'a change could not be stored and was therefore not passed on',
      );
    });
  }

  /** Notes which connection speaks for which awareness client and passes the change to all. */
  function onAwareness(loaded: Loaded, change: AwarenessChange, origin: unknown): void {
    const from = asConnection(origin);
    const touched = [...change.added, ...change.updated, ...change.removed];

    // The latest connection to speak for a client owns it, so a return takes it over.
    if (from !== undefined) {
      for (const clientId of [...change.added, ...change.updated]) {
        loaded.announcedBy.set(clientId, from);
      }
      for (const clientId of change.removed) {
        if (loaded.announcedBy.get(clientId) === from) {
          loaded.announcedBy.delete(clientId);
        }
      }
    }

    // Back to the sender too: a y-websocket client counts it as a sign of life.
    broadcast(loaded.workpiece, encodeAwareness(loaded.workpiece.awareness, touched), undefined);
  }

  /** Holds a workpiece, loading it if nobody holds it yet. */
  function hold(workpieceId: ObjectId): Held {
    const key = workpieceId.toHexString();
    const known = heldByKey.get(key);
    if (known !== undefined) {
      return known;
    }

    // The promise is stored, not the result, so two at once do not each load their own copy.
    const connections = new Set<Connection>();
    const held: Held = { connections, loaded: load(workpieceId, connections) };
    heldByKey.set(key, held);
    return held;
  }

  /** Folds; a failure is only logged, every change is stored and it costs only load time. */
  async function tryFold(loaded: Loaded): Promise<void> {
    try {
      await foldNow(options.db, loaded.stored, loaded.workpiece.doc);
    } catch (error) {
      options.logger.error(
        { err: error, workpieceId: loaded.workpiece.workpieceId.toHexString() },
        'could not fold, the changes stay and the next load reads them',
      );
    }
  }

  /** Closes it for everyone; reloaded from the database, the clients send back what is missing. */
  async function discard(loaded: Loaded): Promise<void> {
    // Passing on what comes after the lost change would leave the others waiting for it.
    discarded.add(loaded);
    const key = loaded.workpiece.workpieceId.toHexString();
    if (heldByKey.get(key)?.connections === loaded.workpiece.connections) {
      heldByKey.delete(key);
    }

    // Emptied first, so the leave that each closing connection sends finds nothing to do.
    const disconnected = [...loaded.workpiece.connections];
    loaded.workpiece.connections.clear();
    for (const connection of disconnected) {
      connection.close(1011, 'could not store a change');
    }
    loaded.workpiece.awareness.destroy();
    loaded.workpiece.doc.destroy();

    await Promise.all(
      disconnected.map((connection) =>
        notePresence(
          loaded.workpiece.workpieceId,
          'left',
          connection.actor,
          loaded.stored.lastUpdateId,
        ),
      ),
    );
  }

  /** Folds and frees the workpiece after the last one left; force is for the shutdown. */
  async function release(key: string, loaded: Loaded, force = false): Promise<void> {
    // Waits until every queued change is stored.
    await loaded.stored.queue;

    // Already closed and freed; folding it now would store the change that failed.
    if (discarded.has(loaded)) {
      return;
    }

    // The last one out folds, the state is in memory anyway.
    await tryFold(loaded);

    // Somebody may have joined meanwhile and holds this very workpiece, so it has to stay.
    if (!force && loaded.workpiece.connections.size > 0) {
      return;
    }

    // Nobody left: free the memory and forget the workpiece.
    loaded.workpiece.awareness.destroy();
    loaded.workpiece.doc.destroy();
    // A second release of the same workpiece must not drop a newer one under the same key.
    if (heldByKey.get(key)?.connections === loaded.workpiece.connections) {
      heldByKey.delete(key);
    }
  }

  /** Takes a connection out, removes its presence and writes left; the last one out releases. */
  async function leaveNow(workpieceId: ObjectId, connection: Connection): Promise<void> {
    const key = workpieceId.toHexString();
    const held = heldByKey.get(key);
    if (held === undefined) {
      return;
    }

    // A load that failed was reported by join already, so there is nothing to leave.
    let loaded: Loaded;
    try {
      loaded = await held.loaded;
    } catch {
      return;
    }

    // Only a connection that joined leaves, and only once.
    if (!loaded.workpiece.connections.delete(connection)) {
      return;
    }

    // Takes away the presence this connection speaks for, not what another one took over.
    const spokenFor = [...loaded.announcedBy]
      .filter(([, speaker]) => speaker === connection)
      .map(([clientId]) => clientId);
    for (const clientId of spokenFor) {
      loaded.announcedBy.delete(clientId);
    }
    if (spokenFor.length > 0) {
      awarenessProtocol.removeAwarenessStates(loaded.workpiece.awareness, spokenFor, null);
    }

    // at: delivered up to here, not read; everything after it this person missed (D6.18).
    await notePresence(workpieceId, 'left', connection.actor, loaded.stored.lastUpdateId);

    // The last one out closes the workpiece.
    if (loaded.workpiece.connections.size === 0) {
      await release(key, loaded);
    }
  }

  return {
    join: async (workpieceId, connection) => {
      const key = workpieceId.toHexString();
      const held = hold(workpieceId);

      // Added before awaiting, so the count is right the moment the caller asks.
      held.connections.add(connection);

      try {
        const workpiece = (await held.loaded).workpiece;
        await notePresence(workpieceId, 'joined', connection.actor);
        return workpiece;
      } catch (error) {
        // Loading failed: forget it, so the next join tries again.
        if (heldByKey.get(key) === held) {
          heldByKey.delete(key);
        }
        throw error;
      }
    },

    leave: async (workpieceId, connection) => {
      const done = leaveNow(workpieceId, connection);
      leaving.add(done);
      try {
        await done;
      } finally {
        leaving.delete(done);
      }
    },

    checkpoint: async (workpieceId, input) => {
      const held = heldByKey.get(workpieceId.toHexString());
      let at: ObjectId | undefined;

      if (held === undefined) {
        // Nobody holds it, so nothing is in flight: the newest id comes from the database.
        if (!(await workpieceExists(options.db, workpieceId))) {
          throw new Error(`unknown workpiece ${workpieceId.toHexString()}`);
        }
        at = await newestUpdateId(options.db, workpieceId);
      } else {
        // Queued like a change, so one still being written lands before the mark.
        const loaded = await held.loaded;
        at = await enqueue(loaded.stored, () => loaded.stored.lastUpdateId);
      }

      return recordEvent(options.db, {
        kind: 'checkpoint',
        createdBy: input.createdBy,
        anchor: anchorOf(workpieceId),
        ...defined({ at, label: input.label, reason: input.reason }),
      });
    },

    count: (workpieceId) => heldByKey.get(workpieceId.toHexString())?.connections.size ?? 0,

    close: async () => {
      // Every left still being written lands before the workpieces go.
      await Promise.allSettled(leaving);

      // Copied first, because releasing removes the entry it is standing on.
      const snapshot = Array.from(heldByKey);

      for (const [key, held] of snapshot) {
        // eslint-disable-next-line no-await-in-loop
        await release(key, await held.loaded, true);
      }
    },
  };
}

/** Sends a message to everybody on the workpiece except whoever it came from. */
function broadcast(
  workpiece: OpenWorkpiece,
  message: Uint8Array,
  from: Connection | undefined,
): void {
  for (const connection of workpiece.connections) {
    if (connection !== from) {
      connection.send(message);
    }
  }
}

/** Sends a message to every connection on the workpiece that asked for events. */
function notify(workpiece: OpenWorkpiece, message: Uint8Array): void {
  for (const connection of workpiece.connections) {
    if (connection.wantsEvents) {
      connection.send(message);
    }
  }
}

/** The anchor that the events of a workpiece hang on. */
function anchorOf(workpieceId: ObjectId): Anchor {
  return { kind: 'workpiece', id: workpieceId };
}

/** The origin of a change as a connection, undefined if it did not come from one. */
function asConnection(origin: unknown): Connection | undefined {
  if (typeof origin === 'object' && origin !== null && 'actor' in origin && 'send' in origin) {
    return origin as Connection;
  }
  return undefined;
}
