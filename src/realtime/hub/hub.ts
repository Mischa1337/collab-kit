import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';

import type { Actor } from '../../model/actor.ts';
import { createActorNotes, type ActorNotes } from '../../db/collections/actors.ts';
import { workpieceExists } from '../../db/collections/workpieces.ts';
import { recordEvent, type EventRecord } from '../../db/collections/events.ts';
import { newestUpdateId } from '../../db/collections/updates.ts';
import { defined } from '../../utils/optional.ts';
import { enqueue, foldNow, loadWorkpiece, storeUpdate, type Stored } from './persistence.ts';
import { encodeAwareness, encodeSyncUpdate, SENDER_DELETES } from '../connection/protocol.ts';
import { deletionsIn, type DeleteSet, type Deletions } from '../conflicts/deletions.ts';
import { anchorOf, createTracing } from '../conflicts/tracing.ts';
import { containersOf } from '../conflicts/units.ts';
import { collect, isReplayer, recordMerge, replay, type Merge } from '../forks/replay.ts';

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
  /** The newest stored change, after whatever is on its way; undefined while there is none. */
  storedUpTo(workpieceId: ObjectId): Promise<ObjectId | undefined>;
  /** Replays the changes of another workpiece as their authors' and writes workpiece-merged. */
  merge(workpieceId: ObjectId, input: Merge): Promise<EventRecord>;
  /** How many connections hold this workpiece right now. */
  count(workpieceId: ObjectId): number;
  /** Lets go of every workpiece, for the shutdown. */
  close(): Promise<void>;
}

/** How many merges run into a workpiece; held and loaded side share it, as its connections. */
interface MergeCount {
  running: number;
}

/** A workpiece the hub holds: its connections at once, the loaded workpiece once it is there. */
interface Held {
  readonly connections: Set<Connection>;
  /** Counted before loading is awaited, so nobody lets go of the Y.Doc under a merge. */
  readonly merges: MergeCount;
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
  /** Merges running into it; while there are any, it stays loaded without anybody connected. */
  readonly merges: MergeCount;
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
  const tracing = createTracing(options.db, options.logger);
  // Every held workpiece by its hex key; counting never has to wait for it to load.
  const heldByKey = new Map<string, Held>();
  // Closed for everyone after a change could not be stored; nothing more is done with them.
  const discarded = new WeakSet<Loaded>();
  // Leaves still being written; close waits for them, so everyone connected gets a left.
  const leaving = new Set<Promise<void>>();
  // Merges still running; close waits for them, so none goes on in a released Y.Doc.
  const merging = new Set<Promise<unknown>>();

  /** Loads the workpiece and wires its Y.Doc and awareness to this hub. */
  async function load(
    workpieceId: ObjectId,
    connections: Set<Connection>,
    merges: MergeCount,
  ): Promise<Loaded> {
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
      merges,
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

      // A merge tells of everything at once when it is done, so here it only collects.
      if (isReplayer(from)) {
        collect(from.found, from.actor.actorId, deletions);
      } else {
        // Only once stored and passed on, so telling of it never holds up the work.
        if (deletions.removals.length > 0) {
          await tracing.traceRemovals(loaded, deletions.removals, from.actor.actorId, updateId);
        }
        if (deletions.losses.length > 0) {
          await tracing.traceLosses(loaded, deletions.losses, from.actor.actorId, updateId);
        }
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
    const merges: MergeCount = { running: 0 };
    const held: Held = { connections, merges, loaded: load(workpieceId, connections, merges) };
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

    // Somebody may have joined meanwhile, or a merge runs into it, so it has to stay.
    if (!force && (loaded.workpiece.connections.size > 0 || loaded.merges.running > 0)) {
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

  /** The newest stored change; queued like a change, so one still being written lands before it. */
  async function storedUpTo(workpieceId: ObjectId): Promise<ObjectId | undefined> {
    const held = heldByKey.get(workpieceId.toHexString());

    // Nobody holds it, so nothing is in flight: the newest id comes from the database.
    if (held === undefined) {
      if (!(await workpieceExists(options.db, workpieceId))) {
        throw new Error(`unknown workpiece ${workpieceId.toHexString()}`);
      }
      return newestUpdateId(options.db, workpieceId);
    }
    const loaded = await held.loaded;
    return enqueue(loaded.stored, () => loaded.stored.lastUpdateId);
  }

  /** Holds the workpiece without presence, replays, tells what it found, and lets go if alone. */
  async function mergeNow(workpieceId: ObjectId, input: Merge): Promise<EventRecord> {
    const key = workpieceId.toHexString();
    const held = hold(workpieceId);

    // Counted before awaiting, as a joining connection is, so the last one leaving meanwhile
    // does not free the Y.Doc under the merge.
    held.merges.running += 1;
    let loaded: Loaded | undefined;
    try {
      try {
        loaded = await held.loaded;
      } catch (error) {
        // Loading failed: forget it, so the next one tries again.
        if (heldByKey.get(key) === held) {
          heldByKey.delete(key);
        }
        throw error;
      }

      const found = await replay(loaded, input.rows, discarded);
      return await recordMerge(options.db, tracing, loaded, input, found);
    } finally {
      held.merges.running -= 1;
      // Nobody connected and no other merge running: let go, as the last one out would.
      if (
        loaded !== undefined &&
        loaded.workpiece.connections.size === 0 &&
        held.merges.running === 0
      ) {
        await release(key, loaded);
      }
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
      const at = await storedUpTo(workpieceId);

      return recordEvent(options.db, {
        kind: 'checkpoint',
        createdBy: input.createdBy,
        anchor: anchorOf(workpieceId),
        ...defined({ at, label: input.label, reason: input.reason }),
      });
    },

    storedUpTo,

    merge: async (workpieceId, input) => {
      const done = mergeNow(workpieceId, input);
      merging.add(done);
      try {
        return await done;
      } finally {
        merging.delete(done);
      }
    },

    count: (workpieceId) => heldByKey.get(workpieceId.toHexString())?.connections.size ?? 0,

    close: async () => {
      // Every left still being written and every merge still running ends before the workpieces go.
      await Promise.allSettled([...leaving, ...merging]);

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

/** The origin of a change as a connection, undefined if it did not come from one. */
function asConnection(origin: unknown): Connection | undefined {
  if (typeof origin === 'object' && origin !== null && 'actor' in origin && 'send' in origin) {
    return origin as Connection;
  }
  return undefined;
}
