import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { Actor } from '../auth/token.ts';
import { createVersion, type DocumentVersion } from '../db/documents.ts';
import { appendVersion, readVersions } from '../db/versions.ts';
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
  /** The document version every incoming change is stored against. Moves on when a
   * new version is set, which is why it is not readonly. */
  baseVersion: number;
  readonly connections: Set<Connection>;
}

export interface MarkVersion {
  readonly actorId: string;
  readonly label?: string;
  readonly reason?: string;
}

export interface DocumentHub {
  join(documentId: ObjectId, connection: Connection): Promise<OpenDocument>;
  leave(documentId: ObjectId, connection: Connection): Promise<void>;
  /** Fixes the current state as a new version, named and reasoned by a person. */
  markVersion(documentId: ObjectId, input: MarkVersion): Promise<DocumentVersion>;
  count(documentId: string): number;
  close(): Promise<void>;
}

interface Entry {
  readonly document: OpenDocument;
  readonly clientIds: Map<Connection, Set<number>>;
  /** Writes run one after another, so the stored order matches the order of arrival. */
  queue: Promise<void>;
}

export interface HubOptions {
  readonly db: Db;
  readonly logger: Logger;
}

/**
 * Keeps one Y.Doc per document while somebody has it open. The truth stays in the
 * database: this is only the working copy, rebuilt from the base plus every change
 * on top of it whenever the first connection arrives.
 */
export function createDocumentHub(options: HubOptions): DocumentHub {
  const entries = new Map<string, Promise<Entry>>();
  // Held next to the promise so counting never has to wait for a document to load.
  const connectionsByKey = new Map<string, Set<Connection>>();

  async function load(documentId: ObjectId, connections: Set<Connection>): Promise<Entry> {
    const current = await options.db
      .collection<DocumentVersion>('documents')
      .findOne({ documentId, isCurrent: true });

    if (current === null) {
      throw new Error(`no current version for document ${documentId.toHexString()}`);
    }

    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(current.state.buffer));

    for (const version of await readVersions(options.db, documentId, current.version)) {
      Y.applyUpdate(doc, new Uint8Array(version.update.buffer));
    }

    const entry: Entry = {
      document: {
        documentId,
        doc,
        awareness: new awarenessProtocol.Awareness(doc),
        baseVersion: current.version,
        connections,
      },
      clientIds: new Map(),
      queue: Promise.resolve(),
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

  /** Stores first, distributes second: nobody shall see a change that is nowhere kept. */
  function onChange(entry: Entry, update: Uint8Array, origin: unknown): void {
    const from = asConnection(origin);

    entry.queue = entry.queue
      .then(async () => {
        if (from === undefined) {
          throw new Error('a change arrived without a connection to attribute it to');
        }

        await appendVersion(options.db, {
          documentId: entry.document.documentId,
          baseVersion: entry.document.baseVersion,
          update,
          actorId: from.actor.actorId,
        });
      })
      .then(() => {
        const message = encodeSyncUpdate(update);
        for (const connection of entry.document.connections) {
          if (connection !== from) {
            connection.send(message);
          }
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

    markVersion: async (documentId, input) => {
      const key = documentId.toHexString();
      const wasOpen = entries.has(key);
      const entry = await entryFor(documentId);

      try {
        // Queued like a change, so nothing slips between the state being read and the
        // new version being written. A change that arrives meanwhile lands either in
        // the new state or behind it, and applying it twice is harmless in Yjs.
        let created: DocumentVersion | undefined;
        const run = entry.queue.then(async () => {
          created = await createVersion(options.db, {
            documentId,
            state: Y.encodeStateAsUpdate(entry.document.doc),
            ...input,
          });
          entry.document.baseVersion = created.version;
        });

        entry.queue = run.catch(() => undefined);
        await run;

        if (created === undefined) {
          throw new Error('the version was not written');
        }
        return created;
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
