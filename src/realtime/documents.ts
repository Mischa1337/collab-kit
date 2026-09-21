import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { Actor } from '../auth/token.ts';
import { findDocument, foldState } from '../db/documents.ts';
import { appendUpdate, readUpdatesSince } from '../db/updates.ts';
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

export interface DocumentHub {
  join(documentId: ObjectId, connection: Connection): Promise<OpenDocument>;
  leave(documentId: ObjectId, connection: Connection): Promise<void>;
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
  readonly clientIds: Map<Connection, Set<number>>;
  /** Writes run one after another, so the stored order matches the order of arrival. */
  queue: Promise<void>;
  /** The newest update written for this document, the cut for the next folding. */
  lastUpdateId?: ObjectId;
  /** What stateThrough holds in the database, as far as this process knows. */
  foldedThrough?: ObjectId;
  /** Updates that have arrived since the last folding. */
  sinceFold: number;
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
 * Keeps one Y.Doc per document while somebody has it open. The truth stays in the
 * database: this is only the working copy, rebuilt from the folded state plus every
 * change after it whenever the first connection arrives.
 */
export function createDocumentHub(options: HubOptions): DocumentHub {
  const foldEvery = options.foldEvery ?? 400;
  const entries = new Map<string, Promise<Entry>>();
  // Held next to the promise so counting never has to wait for a document to load.
  const connectionsByKey = new Map<string, Set<Connection>>();

  async function load(documentId: ObjectId, connections: Set<Connection>): Promise<Entry> {
    const record = await findDocument(options.db, documentId);

    if (record === null) {
      throw new Error(`unknown document ${documentId.toHexString()}`);
    }

    const doc = new Y.Doc();
    if (record.state !== undefined) {
      Y.applyUpdate(doc, new Uint8Array(record.state.buffer));
    }

    // Everything the shortcut does not cover yet. A document that was never folded
    // starts from nothing and reads its whole history, which is just as correct.
    const pending = await readUpdatesSince(options.db, documentId, record.stateThrough);
    for (const row of pending) {
      Y.applyUpdate(doc, new Uint8Array(row.update.buffer));
    }

    const newest = pending.at(-1)?._id ?? record.stateThrough;
    const entry: Entry = {
      document: {
        documentId,
        doc,
        awareness: new awarenessProtocol.Awareness(doc),
        connections,
      },
      clientIds: new Map(),
      queue: Promise.resolve(),
      sinceFold: pending.length,
      ...(newest === undefined ? {} : { lastUpdateId: newest }),
      ...(record.stateThrough === undefined ? {} : { foldedThrough: record.stateThrough }),
    };

    // Attached only now: replaying the stored history must not store it a second time.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
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
   * Takes the state from memory and writes it as the new shortcut. Runs inside the
   * queue, so everything up to lastUpdateId has been stored and is contained in it.
   *
   * A change that arrives while this runs lands behind the cut and is applied on top
   * at the next load. Applying it twice is harmless in Yjs.
   */
  async function foldNow(entry: Entry): Promise<boolean> {
    const through = entry.lastUpdateId;

    if (through === undefined) {
      return false;
    }
    if (entry.foldedThrough !== undefined && through.equals(entry.foldedThrough)) {
      return false;
    }

    const written = await foldState(options.db, {
      documentId: entry.document.documentId,
      state: Y.encodeStateAsUpdate(entry.document.doc),
      through,
      ...(entry.foldedThrough === undefined ? {} : { expected: entry.foldedThrough }),
    });

    if (written) {
      entry.foldedThrough = through;
      entry.sinceFold = 0;
    }
    return written;
  }

  /** Stores first, distributes second: nobody shall see a change that is nowhere kept. */
  function onChange(entry: Entry, update: Uint8Array, origin: unknown): void {
    const from = asConnection(origin);

    entry.queue = entry.queue
      .then(async () => {
        if (from === undefined) {
          throw new Error('a change arrived without a connection to attribute it to');
        }

        const record = await appendUpdate(options.db, {
          documentId: entry.document.documentId,
          update,
          actorId: from.actor.actorId,
        });

        entry.lastUpdateId = record._id;
        entry.sinceFold += 1;
      })
      .then(async () => {
        const message = encodeSyncUpdate(update);
        for (const connection of entry.document.connections) {
          if (connection !== from) {
            connection.send(message);
          }
        }

        if (entry.sinceFold >= foldEvery) {
          await foldNow(entry);
        }
      })
      .catch((error: unknown) => {
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

    const message = encodeAwareness(
      awarenessProtocol.encodeAwarenessUpdate(entry.document.awareness, touched),
    );

    for (const connection of entry.document.connections) {
      if (connection !== from) {
        connection.send(message);
      }
    }
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

  async function release(key: string, entry: Entry): Promise<void> {
    await entry.queue;

    // The last one out folds, because the state is in memory anyway. A failure here
    // may not stop the cleanup: every change is stored, so nothing is at stake.
    try {
      await foldNow(entry);
    } catch (error) {
      options.logger.error(
        { error, documentId: entry.document.documentId.toHexString() },
        'could not fold on release, the changes stay and the next load reads them',
      );
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
        return (await pending).document;
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
        let written = false;
        const run = entry.queue.then(async () => {
          written = await foldNow(entry);
        });

        entry.queue = run.catch(() => undefined);
        await run;
        return written;
      } finally {
        if (!wasOpen && entry.document.connections.size === 0) {
          await release(key, entry);
        }
      }
    },

    count: (documentId) => connectionsByKey.get(documentId)?.size ?? 0,

    close: async () => {
      // Copied first, because releasing removes the entry it is standing on.
      const open = Array.from(entries);

      for (const [key, pending] of open) {
        // eslint-disable-next-line no-await-in-loop
        await release(key, await pending);
      }
    },
  };
}

function asConnection(origin: unknown): Connection | undefined {
  if (typeof origin === 'object' && origin !== null && 'actor' in origin && 'send' in origin) {
    return origin as Connection;
  }
  return undefined;
}
