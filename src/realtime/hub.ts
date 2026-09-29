import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';

import type { Actor } from '../model/actor.ts';
import type { Anchor } from '../model/anchor.ts';
import { touchActor } from '../db/collections/actors.ts';
import { workpieceExists } from '../db/collections/workpieces.ts';
import { recordEvent, type EventRecord } from '../db/collections/events.ts';
import { newestUpdateId } from '../db/collections/updates.ts';
import { defined } from '../utils/optional.ts';
import { enqueue, foldNow, loadWorkpiece, storeUpdate, type Stored } from './persistence.ts';
import { encodeAwareness, encodeSyncUpdate } from './protocol.ts';

/** What the hub needs from a connection, so it does not depend on the transport. */
export interface Connection {
  readonly actor: Actor;
  send(message: Uint8Array): void;
}

/** A workpiece while somebody holds it: its Y.Doc, who is present and who is connected. */
export interface OpenWorkpiece {
  readonly workpieceId: ObjectId;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly connections: Set<Connection>;
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
  /** Writes the state as shortcut for the next load; pure bookkeeping, nothing lost without it. */
  fold(workpieceId: ObjectId): Promise<boolean>;
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
  /** The awareness client ids each connection announced, removed again when it leaves. */
  readonly clientIdsByConnection: Map<Connection, Set<number>>;
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
}

/** Keeps one Y.Doc per open workpiece, passes changes on and keeps traces of who was there. */
export function createWorkpieceHub(options: HubOptions): WorkpieceHub {
  const foldEvery = options.foldEvery ?? 400;
  // Every held workpiece by its hex key; counting never has to wait for it to load.
  const heldByKey = new Map<string, Held>();

  /** Loads the workpiece and wires its Y.Doc and awareness to this hub. */
  async function load(workpieceId: ObjectId, connections: Set<Connection>): Promise<Loaded> {
    const { doc, stored } = await loadWorkpiece(options.db, workpieceId);
    const loaded: Loaded = {
      workpiece: {
        workpieceId,
        doc,
        awareness: new awarenessProtocol.Awareness(doc),
        connections,
      },
      stored,
      clientIdsByConnection: new Map(),
    };

    // Attached only now: replaying the stored history must not store it a second time.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      onUpdate(loaded, update, origin);
    });

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
        { error, kind, workpieceId: workpieceId.toHexString() },
        'could not keep the trace, the work carries on without it',
      );
    }
  }

  /** Leaves the trace joined or left and notes the person as seen; neither fails the caller. */
  async function notePresence(
    workpieceId: ObjectId,
    kind: 'joined' | 'left',
    actor: Actor,
    at?: ObjectId,
  ): Promise<void> {
    await Promise.all([
      trace(workpieceId, kind, actor.actorId, at),
      touchActor(options.db, actor).catch((error: unknown) => {
        options.logger.error({ err: error }, 'could not record the actor');
      }),
    ]);
  }

  /** Stores first, distributes second: nobody shall see a change that is nowhere kept. */
  function onUpdate(loaded: Loaded, update: Uint8Array, origin: unknown): void {
    const from = asConnection(origin);

    // In the queue, so changes are stored in the order they arrived.
    void enqueue(loaded.stored, async () => {
      if (from === undefined) {
        throw new Error('a change arrived without a connection to attribute it to');
      }

      await storeUpdate(options.db, loaded.stored, update, from.actor.actorId);
      broadcast(loaded.workpiece, encodeSyncUpdate(update), from);

      // Now and then, so the next load does not replay the whole history.
      if (loaded.stored.updatesSinceFold >= foldEvery) {
        await foldNow(options.db, loaded.stored, loaded.workpiece.doc);
      }
    }).catch((error: unknown) => {
      options.logger.error(
        { error, workpieceId: loaded.workpiece.workpieceId.toHexString() },
        'a change could not be stored and was therefore not passed on',
      );
    });
  }

  /** Notes whose awareness ids a connection announced and passes the change to the others. */
  function onAwareness(loaded: Loaded, change: AwarenessChange, origin: unknown): void {
    const from = asConnection(origin);
    const touched = [...change.added, ...change.updated, ...change.removed];

    if (from !== undefined) {
      const known = loaded.clientIdsByConnection.get(from) ?? new Set<number>();
      for (const id of [...change.added, ...change.updated]) {
        known.add(id);
      }
      loaded.clientIdsByConnection.set(from, known);
    }

    broadcast(loaded.workpiece, encodeAwareness(loaded.workpiece.awareness, touched), from);
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

  /** Folds and frees the workpiece after the last one left; force is for the shutdown. */
  async function release(key: string, loaded: Loaded, force = false): Promise<void> {
    // Waits until every queued change is stored.
    await loaded.stored.queue;

    // The last one out folds, the state is in memory anyway; a failure costs only load time.
    try {
      await foldNow(options.db, loaded.stored, loaded.workpiece.doc);
    } catch (error) {
      options.logger.error(
        { error, workpieceId: loaded.workpiece.workpieceId.toHexString() },
        'could not fold on release, the changes stay and the next load reads them',
      );
    }

    // Somebody may have joined meanwhile and holds this very workpiece, so it has to stay.
    if (!force && loaded.workpiece.connections.size > 0) {
      return;
    }

    // Nobody left: free the memory and forget the workpiece.
    loaded.workpiece.awareness.destroy();
    loaded.workpiece.doc.destroy();
    heldByKey.delete(key);
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
        heldByKey.delete(key);
        throw error;
      }
    },

    leave: async (workpieceId, connection) => {
      const key = workpieceId.toHexString();
      const held = heldByKey.get(key);
      if (held === undefined) {
        return;
      }

      const loaded = await held.loaded;
      loaded.workpiece.connections.delete(connection);

      // Takes this connection's presence away from the others.
      const ids = loaded.clientIdsByConnection.get(connection);
      if (ids !== undefined && ids.size > 0) {
        awarenessProtocol.removeAwarenessStates(loaded.workpiece.awareness, [...ids], null);
      }
      loaded.clientIdsByConnection.delete(connection);

      // at: delivered up to here, not read; everything after it this person missed (D6.18).
      await notePresence(workpieceId, 'left', connection.actor, loaded.stored.lastUpdateId);

      // The last one out closes the workpiece.
      if (loaded.workpiece.connections.size === 0) {
        await release(key, loaded);
      }
    },

    fold: async (workpieceId) => {
      const key = workpieceId.toHexString();
      const wasOpen = heldByKey.has(key);
      const loaded = await hold(workpieceId).loaded;

      try {
        // Queued like a change, so nothing slips between reading the state and writing it.
        return await enqueue(loaded.stored, () =>
          foldNow(options.db, loaded.stored, loaded.workpiece.doc),
        );
      } finally {
        // A workpiece opened only for this goes again.
        if (!wasOpen && loaded.workpiece.connections.size === 0) {
          await release(key, loaded);
        }
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
