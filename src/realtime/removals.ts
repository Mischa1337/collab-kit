import type { ObjectId } from 'mongodb';
import * as Y from 'yjs';

import type { NewEvent } from '../db/collections/events.ts';
import type { Anchor } from '../model/anchor.ts';

/** At most this many stretches go into one event; beyond that only how many there were. */
const MAX_RANGES = 100;

/** The deletions an update carries; Yjs does not export the type itself. */
export type DeleteSet = ReturnType<typeof Y.decodeUpdate>['ds'];

/** A stretch of pieces of one Yjs client that a change deleted, named by their Yjs ids. */
export interface Removal {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
  /** Whether its key holds another value afterwards; otherwise it is simply gone. */
  readonly replaced: boolean;
}

/** A stretch of clocks of one client, as Yjs keeps them in a delete set. */
interface Range {
  readonly clock: number;
  readonly len: number;
}

/** What the removal events have in common: who did it, where, and with which change. */
interface RemovalBase {
  readonly createdBy: string;
  readonly anchor: Anchor;
  readonly at: ObjectId;
}

/** What the transaction newly deleted that the sender had deleted too, so had in front of them. */
export function removalsIn(transaction: Y.Transaction, known: DeleteSet): Removal[] {
  const found: Removal[] = [];

  transaction.deleteSet.clients.forEach((deleted, client) => {
    const structs = transaction.doc.store.clients.get(client);
    const sent = known.clients.get(client);
    if (structs === undefined || sent === undefined) {
      return;
    }

    // Compared by clock, not by piece: Yjs merges pieces, the sender may have known only a part.
    for (const part of deleted.flatMap((range) => overlaps(range, sent))) {
      found.push(...piecesIn(structs, client, part));
    }
  });

  return merged(found);
}

/** One event per kind and person whose work it was; the remover's own work is left out. */
export function removalEvents(
  removals: readonly Removal[],
  authors: ReadonlyMap<number, string>,
  base: RemovalBase,
): NewEvent[] {
  const groups = new Map<string, { kind: string; affected: string; ranges: object[] }>();

  // Grouped by kind and author; whose author is unknown stays out.
  for (const removal of removals) {
    const author = authors.get(removal.client);
    if (author === undefined || author === base.createdBy) {
      continue;
    }
    const kind = removal.replaced ? 'work-replaced' : 'work-removed';
    const key = JSON.stringify([kind, author]);
    const group = groups.get(key) ?? { kind, affected: author, ranges: [] };
    group.ranges.push({ client: removal.client, clock: removal.clock, length: removal.length });
    groups.set(key, group);
  }

  // Many stretches would only bloat the event, their count is enough then.
  return [...groups.values()].map((group) => ({
    kind: group.kind,
    createdBy: base.createdBy,
    anchor: base.anchor,
    at: base.at,
    affects: [group.affected],
    detail:
      group.ranges.length > MAX_RANGES
        ? { rangeCount: group.ranges.length }
        : { ranges: group.ranges },
  }));
}

/** The parts of a range that also lie in any of the others. */
function overlaps(range: Range, others: readonly Range[]): Range[] {
  const end = range.clock + range.len;

  return others.flatMap((other) => {
    const from = Math.max(range.clock, other.clock);
    const to = Math.min(end, other.clock + other.len);
    return from < to ? [{ clock: from, len: to - from }] : [];
  });
}

/** The pieces a stretch covers, each cut to the stretch. */
function piecesIn(structs: (Y.Item | Y.GC)[], client: number, part: Range): Removal[] {
  const end = part.clock + part.len;
  const pieces: Removal[] = [];
  let clock = part.clock;
  let index = Y.findIndexSS(structs, clock);

  // Walks from piece to piece until the stretch is covered.
  while (clock < end) {
    const struct = structs[index];
    if (struct === undefined) {
      break;
    }
    const stop = Math.min(end, struct.id.clock + struct.length);
    // Only an item still knows where it sat; anything else was gone before.
    if (struct instanceof Y.Item) {
      pieces.push({ client, clock, length: stop - clock, replaced: isReplaced(struct) });
    }
    clock = stop;
    index += 1;
  }
  return pieces;
}

/** Whether the piece sat under a key that holds a living value again. */
function isReplaced(item: Y.Item): boolean {
  if (item.parentSub === null) {
    return false;
  }

  // The values of one key form a chain, the current one at its right end.
  let current = item;
  while (current.right !== null) {
    current = current.right;
  }
  return !current.deleted;
}

/** Joins stretches that follow on one another and went alike, so the list stays short. */
function merged(removals: readonly Removal[]): Removal[] {
  const joined: Removal[] = [];

  for (const next of removals) {
    const last = joined.at(-1);
    if (
      last !== undefined &&
      last.client === next.client &&
      last.replaced === next.replaced &&
      last.clock + last.length === next.clock
    ) {
      joined[joined.length - 1] = { ...last, length: last.length + next.length };
    } else {
      joined.push(next);
    }
  }
  return joined;
}
