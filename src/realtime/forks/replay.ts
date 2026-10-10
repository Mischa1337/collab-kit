import type { Db } from 'mongodb';
import type * as Y from 'yjs';

import { recordEvent, type EventRecord } from '../../db/collections/events.ts';
import type { UpdateRecord } from '../../db/collections/updates.ts';
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

/** What a merge found while replaying, per author, to be told once it is done. */
interface Found {
  readonly removals: Map<string, Removal[]>;
  readonly losses: Map<string, Loss[]>;
  /** How many changes brought the target anything, and by whom. */
  stored: number;
  readonly authors: Set<string>;
}

/** Stands in for the author of a replayed change: no socket, nothing to send, it only collects. */
interface Replayer extends Connection {
  readonly found: Found;
}

/** Applies each change as its author sent it, one stored before the next; a failed store ends. */
export async function replay(
  loaded: MergeTarget,
  rows: readonly UpdateRecord[],
  discarded: { has(loaded: MergeTarget): boolean },
): Promise<Found> {
  const found: Found = { removals: new Map(), losses: new Map(), stored: 0, authors: new Set() };

  for (const row of rows) {
    // Closed after a failed store: the merge stops, asking again goes on from the mark.
    if (discarded.has(loaded)) {
      throw new Error('a change could not be stored, so the merge stopped');
    }
    // A sender without a socket: stored under the author, passed on to everyone connected.
    const sender: Replayer = {
      actor: { actorId: row.createdBy },
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
  // The state afterwards; every replayed change is stored by now.
  const at = loaded.stored.lastUpdateId;
  // Whose work came in, besides whoever merged it.
  const affects = [...found.authors].filter((author) => author !== input.createdBy);

  // First, so the events of what it found can name it.
  const merged = await recordEvent(db, {
    kind: 'workpiece-merged',
    createdBy: input.createdBy,
    anchor: anchorOf(workpieceId),
    ...defined({ at, reason: input.reason, affects: affects.length > 0 ? affects : undefined }),
    detail: { from: input.from, ...defined({ upTo: input.upTo }), count: found.stored },
  });

  // Bundled over the whole merge: one event per kind, author, person and unit, as live.
  if (at !== undefined) {
    const extra = { merge: merged._id };
    await Promise.all([
      ...[...found.removals].map(([author, removals]) =>
        tracing.traceRemovals(loaded, removals, author, at, extra),
      ),
      ...[...found.losses].map(([author, losses]) =>
        tracing.traceLosses(loaded, losses, author, at, extra),
      ),
    ]);
  }
  return merged;
}

/** Keeps what a replayed change deleted under its author, and that it brought something. */
export function collect(found: Found, author: string, deletions: Deletions): void {
  found.stored += 1;
  found.authors.add(author);
  found.removals.set(author, [...(found.removals.get(author) ?? []), ...deletions.removals]);
  found.losses.set(author, [...(found.losses.get(author) ?? []), ...deletions.losses]);
}

/** Whether a sender stands in for the author of a replayed change. */
export function isReplayer(connection: Connection): connection is Replayer {
  return 'found' in connection;
}
