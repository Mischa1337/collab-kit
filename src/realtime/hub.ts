import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';

import type { Actor } from '../model/actor.ts';
import type { Anchor } from '../model/anchor.ts';
import { touchActor } from '../db/collections/actors.ts';
import { documentExists } from '../db/collections/documents.ts';
import { recordEvent, type EventRecord } from '../db/collections/events.ts';
import { newestUpdate } from '../db/collections/updates.ts';
import { defined } from '../utils/optional.ts';
import { enqueue, foldNow, loadWorkingCopy, storeUpdate, type WorkingCopy } from './persistence.ts';
import { encodeAwareness, encodeSyncUpdate } from './sync.ts';

/** What the hub needs from a connection, so it does not depend on the transport. */
export interface Connection {
  readonly actor: Actor;
  send(message: Uint8Array): void;
}

export interface OpenDocument {
  readonly documentId: ObjectId;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly connections: Set<Connection>;
}

export interface Checkpoint {
  readonly actorId: string;
  readonly label?: string;
  readonly reason?: string;
}

export interface DocumentHub {
  join(documentId: ObjectId, connection: Connection): Promise<OpenDocument>;
  leave(documentId: ObjectId, connection: Connection): Promise<void>;
  /**
   * Holds this moment as an event that a person named. Not a technical matter: a
   * checkpoint says that a state is worth coming back to, and reason is the only
   * place in the whole model where the why of a change can live.
   */
  checkpoint(documentId: ObjectId, input: Checkpoint): Promise<EventRecord>;
  /**
   * Writes the current state as the shortcut for the next load. Pure bookkeeping:
   * nothing becomes visible by it and nothing is lost without it.
   */
  fold(documentId: ObjectId): Promise<boolean>;
  count(documentId: string): number;
  close(): Promise<void>;
}

interface Entry {
  readonly document: OpenDocument;
  /** The stored side of the same document: its queue and how far it is kept. */
  readonly copy: WorkingCopy;
  readonly clientIds: Map<Connection, Set<number>>;
}

export interface HubOptions {
  readonly db: Db;
  readonly logger: Logger;
  /**
   * How many changes may pile up before the state is folded again. Only a matter of
   * loading time, which is why a document that stays open all day still gets folded.
   */
  readonly foldEvery?: number;
}

/**
 * Keeps one Y.Doc per document while somebody has it open, passes every change on to
 * the others and keeps the traces of who was there. How the working copy is loaded,
 * stored and folded lives in persistence.ts.
 */
export function createDocumentHub(options: HubOptions): DocumentHub {
  const foldEvery = options.foldEvery ?? 400;
  const entries = new Map<string, Promise<Entry>>();
  // Held next to the promise so counting never has to wait for a document to load.
  const connectionsByKey = new Map<string, Set<Connection>>();

  async function load(documentId: ObjectId, connections: Set<Connection>): Promise<Entry> {
    const copy = await loadWorkingCopy(options.db, documentId);
    const entry: Entry = {
      document: {
        documentId,
        doc: copy.doc,
        awareness: new awarenessProtocol.Awareness(copy.doc),
        connections,
      },
      copy,
      clientIds: new Map(),
    };

    // Attached only now: replaying the stored history must not store it a second time.
    copy.doc.on('update', (update: Uint8Array, origin: unknown) => {
      onChange(entry, update, origin);
    });

    entry.document.awareness.on(
      'update',
      (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        onAwareness(entry, change, origin);
      },
    );

    return entry;
  }

  /**
   * Keeping a trace may never break the work it is a trace of. A lost event costs a
   * line in a history, a thrown one would cost the connection.
   */
  async function trace(documentId: ObjectId, kind: string, actor: string, at?: ObjectId) {
    try {
      await recordEvent(options.db, {
        kind,
        actorId: actor,
        anchor: anchorOf(documentId),
        ...defined({ at }),
      });
    } catch (error) {
      options.logger.error(
        { error, kind, documentId: documentId.toHexString() },
        'could not keep the trace, the work carries on without it',
      );
    }
  }

  /** Stores first, distributes second: nobody shall see a change that is nowhere kept. */
  function onChange(entry: Entry, update: Uint8Array, origin: unknown): void {
    const from = asConnection(origin);

    void enqueue(entry.copy, async () => {
      if (from === undefined) {
        throw new Error('a change arrived without a connection to attribute it to');
      }

      await storeUpdate(options.db, entry.copy, update, from.actor.actorId);
      broadcast(entry.document, encodeSyncUpdate(update), from);

      if (entry.copy.sinceFold >= foldEvery) {
        await foldNow(options.db, entry.copy);
      }
    }).catch((error: unknown) => {
      options.logger.error(
        { error, documentId: entry.document.documentId.toHexString() },
        'a change could not be stored and was therefore not passed on',
      );
    });
  }

  function onAwareness(
    entry: Entry,
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void {
    const from = asConnection(origin);
    const touched = [...change.added, ...change.updated, ...change.removed];

    if (from !== undefined) {
      const known = entry.clientIds.get(from) ?? new Set<number>();
      for (const id of [...change.added, ...change.updated]) {
        known.add(id);
      }
      entry.clientIds.set(from, known);
    }

    broadcast(
      entry.document,
      encodeAwareness(awarenessProtocol.encodeAwarenessUpdate(entry.document.awareness, touched)),
      from,
    );
  }

  function entryFor(documentId: ObjectId): Promise<Entry> {
    const key = documentId.toHexString();
    const known = entries.get(key);
    if (known !== undefined) {
      return known;
    }

    // The promise is stored, not the result: two connections arriving at the same
    // moment must not each build their own copy of the same document.
    const connections = new Set<Connection>();
    const pending = load(documentId, connections);
    connectionsByKey.set(key, connections);
    entries.set(key, pending);
    return pending;
  }

  /**
   * Gives the working copy up once the last connection has gone. force is for the
   * shutdown, where the document goes whether somebody still holds it or not.
   */
  async function release(key: string, entry: Entry, force = false): Promise<void> {
    await entry.copy.queue;

    // The last one out folds, because the state is in memory anyway. A failure here
    // may not stop the cleanup: every change is stored, so nothing is at stake.
    try {
      await foldNow(options.db, entry.copy);
    } catch (error) {
      options.logger.error(
        { error, documentId: entry.document.documentId.toHexString() },
        'could not fold on release, the changes stay and the next load reads them',
      );
    }

    // Somebody may have joined again while this was waiting. They were handed this
    // very document, so destroying it now would leave them holding a dead copy.
    if (!force && entry.document.connections.size > 0) {
      return;
    }

    entry.document.awareness.destroy();
    entry.document.doc.destroy();
    entries.delete(key);
    connectionsByKey.delete(key);
  }

  return {
    join: async (documentId, connection) => {
      const key = documentId.toHexString();
      const pending = entryFor(documentId);

      // Added before awaiting, so the count is right the moment the caller asks.
      connectionsByKey.get(key)?.add(connection);

      try {
        const document = (await pending).document;

        await Promise.all([
          trace(documentId, 'joined', connection.actor.actorId),
          touchActor(options.db, connection.actor).catch((error: unknown) => {
            options.logger.error({ error }, 'could not record the actor');
          }),
        ]);

        return document;
      } catch (error) {
        entries.delete(key);
        connectionsByKey.delete(key);
        throw error;
      }
    },

    leave: async (documentId, connection) => {
      const key = documentId.toHexString();
      const pending = entries.get(key);
      if (pending === undefined) {
        return;
      }

      const entry = await pending;
      entry.document.connections.delete(connection);

      const ids = entry.clientIds.get(connection);
      if (ids !== undefined && ids.size > 0) {
        awarenessProtocol.removeAwarenessStates(entry.document.awareness, [...ids], null);
      }
      entry.clientIds.delete(connection);

      // The position is what makes D6.18 answerable later: everything after it is
      // what this person was not around for. It says delivered, not read; what a
      // person actually looked at only the tool can report.
      await Promise.all([
        trace(documentId, 'left', connection.actor.actorId, entry.copy.lastUpdateId),
        touchActor(options.db, connection.actor).catch((error: unknown) => {
          options.logger.error({ error }, 'could not record the actor');
        }),
      ]);

      if (entry.document.connections.size === 0) {
        await release(key, entry);
      }
    },

    fold: async (documentId) => {
      const key = documentId.toHexString();
      const wasOpen = entries.has(key);
      const entry = await entryFor(documentId);

      try {
        // Queued like a change, so nothing slips between reading the state and
        // writing it.
        return await enqueue(entry.copy, () => foldNow(options.db, entry.copy));
      } finally {
        if (!wasOpen && entry.document.connections.size === 0) {
          await release(key, entry);
        }
      }
    },

    checkpoint: async (documentId, input) => {
      const pending = entries.get(documentId.toHexString());
      let at: ObjectId | undefined;

      if (pending === undefined) {
        // Nothing in flight on a document nobody holds, and loading the whole Y.Doc
        // only to read the newest id would be wasteful.
        if (!(await documentExists(options.db, documentId))) {
          throw new Error(`unknown document ${documentId.toHexString()}`);
        }
        at = await newestUpdate(options.db, documentId);
      } else {
        // Queued like a change, so a change still being written lands before the
        // mark and not behind it.
        const entry = await pending;
        at = await enqueue(entry.copy, () => entry.copy.lastUpdateId);
      }

      return recordEvent(options.db, {
        kind: 'checkpoint',
        actorId: input.actorId,
        anchor: anchorOf(documentId),
        ...defined({ at, label: input.label, reason: input.reason }),
      });
    },

    count: (documentId) => connectionsByKey.get(documentId)?.size ?? 0,

    close: async () => {
      // Copied first, because releasing removes the entry it is standing on.
      const open = Array.from(entries);

      for (const [key, pending] of open) {
        // eslint-disable-next-line no-await-in-loop
        await release(key, await pending, true);
      }
    },
  };
}

/** Sends a message to everybody on the document except whoever it came from. */
function broadcast(
  document: OpenDocument,
  message: Uint8Array,
  from: Connection | undefined,
): void {
  for (const connection of document.connections) {
    if (connection !== from) {
      connection.send(message);
    }
  }
}

function anchorOf(documentId: ObjectId): Anchor {
  return { kind: 'document', id: documentId };
}

function asConnection(origin: unknown): Connection | undefined {
  if (typeof origin === 'object' && origin !== null && 'actor' in origin && 'send' in origin) {
    return origin as Connection;
  }
  return undefined;
}
