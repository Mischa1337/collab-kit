import type { Db, ObjectId } from 'mongodb';
import type * as Y from 'yjs';

import { stampsFor } from '../../auth/anonymity.ts';
import { recordEvent, type EventRecord } from '../../db/collections/events.ts';
import { stampsOf, type Author } from '../../db/collections/pseudonyms.ts';
import { defined } from '../../utils/optional.ts';
import { applyAsSent } from '../connection/protocol.ts';
import type { Deletions, Loss, Removal } from '../conflicts/deletions.ts';
import { anchorOf, type TraceTarget, type Tracing } from '../conflicts/tracing.ts';
import type { Stored } from '../hub/persistence.ts';
import type { Connection, Merge } from '../hub/types.ts';

/** What a merge needs of the workpiece: what tracing needs, its Y.Doc, its queue and newest change. */
interface MergeTarget extends TraceTarget {
  readonly workpiece: TraceTarget['workpiece'] & { readonly doc: Y.Doc };
  /** The object itself, not its values: every stored change moves both on. */
  readonly stored: Pick<Stored, 'queue' | 'lastUpdateId'>;
}

/** What a merge found while replaying, per author as stored at the target, told once it is done. */
interface Found {
  /** What each author removed and lost to others, by key and pseudonym together. */
  readonly removals: Map<string, Removal[]>;
  readonly losses: Map<string, Loss[]>;
  /** How many changes brought the target anything, and by whom, under the same key. */
  stored: number;
  readonly authors: Map<string, Author>;
  /** The last change stored in the target before the first one replayed; undefined if none. */
  since: ObjectId | undefined;
}

/** Stands in for the author of a replayed change: no socket, nothing to send, it only collects. */
interface Replayer extends Connection {
  readonly found: Found;
}

/** Applies each change as its author sent it, one stored before the next; a failed store ends. */
export async function replay(
  loaded: MergeTarget,
  input: Pick<Merge, 'rows' | 'writers'>,
  discarded: { has(loaded: MergeTarget): boolean },
): Promise<Found> {
  const found: Found = {
    removals: new Map(),
    losses: new Map(),
    stored: 0,
    authors: new Map(),
    since: undefined,
  };

  for (const row of input.rows) {
    // Closed after a failed store: the merge stops, asking again goes on from the mark.
    if (discarded.has(loaded)) {
      throw new Error('a change could not be stored, so the merge stopped');
    }
    // A sender without a socket: stored under the author, as the target decided, passed on to all.
    const sender: Replayer = {
      actor: { actorId: row.createdBy },
      ...defined({ pseudonym: input.writers.get(row._id.toHexString()) }),
      wantsEvents: false,
      send: () => {},
      close: () => {},
      found,
    };
    applyAsSent(loaded.workpiece.doc, new Uint8Array(row.bytes.buffer), sender);
    // Stored before the next one, so a long history does not hold up the others.
    // eslint-disable-next-line no-await-in-loop
    await loaded.stored.queue;
  }

  if (discarded.has(loaded)) {
    throw new Error('a change could not be stored, so the merge stopped');
  }
  return found;
}

/** Writes workpiece-merged, then per author what the replay found; work-lost goes out at once. */
export async function recordMerge(
  db: Db,
  tracing: Tracing,
  loaded: MergeTarget,
  input: Merge,
  found: Found,
): Promise<EventRecord> {
  const workpieceId = loaded.workpiece.workpieceId;
  const target = anchorOf(workpieceId);
  // The state afterwards; every replayed change is stored by now.
  const at = loaded.stored.lastUpdateId;
  // Whose work came in, besides whoever merged it, each stamped as it is stored there.
  const authors = [...found.authors.values()].filter(
    (author) => author.actorId !== input.createdBy,
  );
  const affects = [...new Set(authors.map((author) => author.actorId))];
  // Whoever merges is asked at the target, as for a change of their own there.
  const merger = await stampsFor(db, [input.createdBy], { places: [target], about: target });

  // First, so the events of what it found can name it.
  const merged = await recordEvent(db, {
    kind: 'workpiece-merged',
    createdBy: input.createdBy,
    anchor: target,
    ...defined({ at, reason: input.reason, affects: affects.length > 0 ? affects : undefined }),
    detail: { from: input.from, ...defined({ upTo: input.upTo }), count: found.stored },
    anonymous: [...merger, ...stampsOf(authors)],
  });

  // Bundled over the whole merge: one event per kind, author, person and unit, as live.
  if (at !== undefined) {
    const extra = { merge: merged._id, ...defined({ since: found.since }) };
    await Promise.all(
      [...found.authors].flatMap(([key, author]) => [
        tracing.traceRemovals(loaded, found.removals.get(key) ?? [], author, at, extra),
        tracing.traceLosses(loaded, found.losses.get(key) ?? [], author, at, extra),
      ]),
    );
  }
  return merged;
}

/** Keeps what a replayed change deleted under its author, and that it brought something. */
export function collect(
  found: Found,
  author: Author,
  deletions: Deletions,
  since: ObjectId | undefined,
): void {
  // The first one says where the merge starts.
  if (found.stored === 0) {
    found.since = since;
  }
  found.stored += 1;
  // Open and anonymous changes of one person are told apart, as live.
  const key = JSON.stringify([author.actorId, author.as ?? null]);
  found.authors.set(key, author);
  found.removals.set(key, [...(found.removals.get(key) ?? []), ...deletions.removals]);
  found.losses.set(key, [...(found.losses.get(key) ?? []), ...deletions.losses]);
}

/** Whether a sender stands in for the author of a replayed change. */
export function isReplayer(connection: Connection): connection is Replayer {
  return 'found' in connection;
}
