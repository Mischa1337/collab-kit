import type { ObjectId } from 'mongodb';

import type { NewEvent } from '../../db/collections/events.ts';
import type { Anchor } from '../../model/anchor.ts';
import { defined } from '../../utils/optional.ts';
import { idKey, type Loss, type Removal, type Stretch } from './deletions.ts';

/** At most this many stretches go into one event; beyond that only how many there were. */
const MAX_RANGES = 100;

/** What the removal events have in common: who did it, where, and with which change. */
interface RemovalBase {
  readonly createdBy: string;
  readonly anchor: Anchor;
  readonly at: ObjectId;
}

/** What the loss events have in common: where, with which change, and who sent it. */
interface LossBase {
  readonly anchor: Anchor;
  readonly at: ObjectId;
  readonly sender: string;
}

/** One group of removals that becomes one event. */
interface RemovalGroup {
  readonly kind: string;
  readonly affected: string;
  readonly unit: string | undefined;
  readonly ranges: Stretch[];
}

/** One group of losses that becomes one event. */
interface LossGroup {
  readonly loss: Loss;
  readonly loser: string;
  readonly other: string | undefined;
  readonly lost: Stretch[];
}

/** One event per kind, person whose work it was and unit; the remover's own work is left out. */
export function removalEvents(
  removals: readonly Removal[],
  authors: ReadonlyMap<number, string>,
  base: RemovalBase,
): NewEvent[] {
  const groups = new Map<string, RemovalGroup>();

  // Grouped by kind, author and unit; whose author is unknown stays out.
  for (const removal of removals) {
    const author = authors.get(removal.client);
    if (author === undefined || author === base.createdBy) {
      continue;
    }
    const kind = removal.replaced ? 'work-replaced' : 'work-removed';
    const key = JSON.stringify([kind, author, removal.unit ?? null]);
    const group = groups.get(key) ?? { kind, affected: author, unit: removal.unit, ranges: [] };
    group.ranges.push({ client: removal.client, clock: removal.clock, length: removal.length });
    groups.set(key, group);
  }

  // Many stretches would only bloat the event, their count is enough then.
  return [...groups.values()].map((group) => ({
    kind: group.kind,
    createdBy: base.createdBy,
    anchor: inUnit(base.anchor, group.unit),
    at: base.at,
    affects: [group.affected],
    detail:
      group.ranges.length > MAX_RANGES
        ? { rangeCount: group.ranges.length }
        : { ranges: group.ranges },
  }));
}

/** One work-lost per cause, place or value, loser, other side and unit; none if both are one. */
export function lossEvents(
  losses: readonly Loss[],
  authors: ReadonlyMap<number, string>,
  deleters: ReadonlyMap<string, string>,
  base: LossBase,
): NewEvent[] {
  const groups = new Map<string, LossGroup>();

  for (const loss of losses) {
    // Whose piece it was; an unknown author stays out.
    const loser = authors.get(loss.client);
    if (loser === undefined) {
      continue;
    }
    // Who is behind it: the author of the value now, or whoever deleted the place.
    const other =
      loss.cause === 'overwritten'
        ? authors.get(loss.other.client)
        : deleters.get(idKey(loss.other));
    // Two tabs of one person: nobody lost anything to anybody.
    if (other === loser) {
      continue;
    }

    const key = JSON.stringify([
      loss.cause,
      idKey(loss.other),
      loser,
      other ?? null,
      loss.unit ?? null,
    ]);
    const group = groups.get(key) ?? { loss, loser, other, lost: [] };
    group.lost.push({ client: loss.client, clock: loss.clock, length: loss.length });
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => lossEvent(group, base));
}

/** The event of one group; without another side the sender stands in and says so. */
function lossEvent(group: LossGroup, base: LossBase): NewEvent {
  const { loss, loser, other, lost } = group;
  const where = loss.cause === 'overwritten' ? 'current' : 'removed';

  return {
    kind: 'work-lost',
    createdBy: other ?? base.sender,
    anchor: inUnit(base.anchor, loss.unit),
    at: base.at,
    affects: other === undefined ? [loser] : [loser, other],
    detail: {
      cause: loss.cause,
      // Many stretches would only bloat the event, their count is enough then.
      ...(lost.length > MAX_RANGES ? { lostCount: lost.length } : { lost }),
      [where]: { client: loss.other.client, clock: loss.other.clock },
      ...(other === undefined ? { otherUnknown: true } : {}),
    },
  };
}

/** The anchor narrowed to the unit, if the pieces lie in one. */
function inUnit(anchor: Anchor, unit: string | undefined): Anchor {
  return { ...anchor, ...defined({ unit }) };
}
