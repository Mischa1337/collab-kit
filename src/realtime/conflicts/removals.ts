import type { ObjectId } from 'mongodb';
import * as Y from 'yjs';

import type { NewEvent } from '../../db/collections/events.ts';
import type { UnitContainer } from '../../db/collections/workpieces.ts';
import type { Anchor } from '../../model/anchor.ts';
import { defined } from '../../utils/optional.ts';

/** At most this many stretches go into one event; beyond that only how many there were. */
const MAX_RANGES = 100;

/** The deletions an update carries; Yjs does not export the type itself. */
export type DeleteSet = ReturnType<typeof Y.decodeUpdate>['ds'];

/** A piece by its Yjs id, as events name it. */
export interface PieceId {
  readonly client: number;
  readonly clock: number;
}

/** A stretch of pieces of one Yjs client, named by their Yjs ids. */
interface Stretch extends PieceId {
  readonly length: number;
}

/** A stretch of pieces and the unit they lie in. */
interface UnitStretch extends Stretch {
  /** The key of the unit, as anchor.unit names it; absent outside every unit. */
  readonly unit?: string;
}

/** The maps whose keys are units, each by its path, ready to be looked up. */
export type Containers = ReadonlySet<string>;

/** A stretch of pieces the sender deleted with them in front of them. */
export interface Removal extends UnitStretch {
  /** Whether its key holds another value afterwards; otherwise it is simply gone. */
  readonly replaced: boolean;
}

/** A stretch of pieces lost to a change whose sender never knew them. */
export interface Loss extends UnitStretch {
  /** overwritten: another value took the key. place-removed: what it sat in was deleted. */
  readonly cause: 'overwritten' | 'place-removed';
  /** overwritten: the value under the key now. place-removed: the deleted place. */
  readonly other: PieceId;
  /** Whether this very change deleted the place, so its sender is who removed it. */
  readonly removedNow: boolean;
}

/** What a change deleted, split by whether its sender had it in front of them. */
export interface Deletions {
  readonly removals: Removal[];
  readonly losses: Loss[];
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

/** The maps a workpiece names as holding units, looked up by path. */
export function containersOf(units: readonly UnitContainer[]): Containers {
  return new Set(units.map((container) => pathKey(container.path)));
}

/** Splits what a transaction newly deleted, before Yjs collects it and pieces lose their place. */
export function deletionsIn(
  transaction: Y.Transaction,
  known: DeleteSet,
  containers: Containers,
): Deletions {
  const removals: Removal[] = [];
  const losses: Loss[] = [];
  // Lost is what this change deleted although its sender never knew it.
  const isLost = (id: PieceId): boolean =>
    Y.isDeleted(transaction.deleteSet, id as Y.ID) && !Y.isDeleted(known, id as Y.ID);

  transaction.deleteSet.clients.forEach((deleted, client) => {
    const structs = transaction.doc.store.clients.get(client);
    if (structs === undefined) {
      return;
    }
    const sent = known.clients.get(client) ?? [];

    // Compared by clock, not by piece: Yjs merges pieces, the sender may have known only a part.
    for (const range of deleted) {
      for (const { item, clock, length } of overlaps(range, sent).flatMap((part) =>
        itemsIn(structs, part),
      )) {
        removals.push({
          client,
          clock,
          length,
          replaced: isReplaced(item),
          ...defined({ unit: unitOf(item, containers) }),
        });
      }
      for (const { item, clock, length } of outside(range, sent).flatMap((part) =>
        itemsIn(structs, part),
      )) {
        const why = lossOf(item, isLost, transaction.deleteSet);
        if (why !== undefined) {
          losses.push({
            client,
            clock,
            length,
            ...why,
            ...defined({ unit: unitOf(item, containers) }),
          });
        }
      }
    }
  });

  return {
    removals: merged(removals, (a, b) => a.replaced === b.replaced),
    losses: merged(
      losses,
      (a, b) =>
        a.cause === b.cause && idKey(a.other) === idKey(b.other) && a.removedNow === b.removedNow,
    ),
  };
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

/** The key under which a piece is looked up, as a map cannot compare ids. */
export function idKey(id: PieceId): string {
  return `${id.client}:${id.clock}`;
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

/** Why a piece was lost: its place went, or another value took its key; undefined if neither. */
function lossOf(
  item: Y.Item,
  isLost: (id: PieceId) => boolean,
  deletedNow: DeleteSet,
): Pick<Loss, 'cause' | 'other' | 'removedNow'> | undefined {
  // Up through what was lost along with it, to the piece the change actually hit.
  let top = item;
  let place = placeOf(top);
  while (place !== null && isLost(place.id)) {
    top = place;
    place = placeOf(top);
  }

  if (place !== null && place.deleted) {
    return {
      cause: 'place-removed',
      other: { client: place.id.client, clock: place.id.clock },
      removedNow: Y.isDeleted(deletedNow, place.id),
    };
  }

  // Otherwise only a newer value under the same key can have pushed it out.
  const current = top.parentSub === null ? top : newestUnder(top);
  if (current === top) {
    return undefined;
  }
  return {
    cause: 'overwritten',
    other: { client: current.id.client, clock: current.id.clock },
    removedNow: false,
  };
}

/** The anchor narrowed to the unit, if the pieces lie in one. */
function inUnit(anchor: Anchor, unit: string | undefined): Anchor {
  return { ...anchor, ...defined({ unit }) };
}

/** The unit of a piece: the key under which it, or what holds it, sits directly in a container. */
function unitOf(item: Y.Item, containers: Containers): string | undefined {
  // Up from the piece; the first container on the way is the innermost.
  for (let piece: Y.Item | null = item; piece !== null; piece = placeOf(piece)) {
    const key = piece.parentSub;
    if (key !== null && isContainer(piece.parent, containers)) {
      // A blank key could never be asked for, so it names no unit.
      return key.trim() === '' ? undefined : key;
    }
  }
  return undefined;
}

/** Whether the workpiece names the type a piece sits in as holding units. */
function isContainer(parent: Y.Item['parent'], containers: Containers): boolean {
  if (containers.size === 0 || !(parent instanceof Y.AbstractType)) {
    return false;
  }
  const path = pathOf(parent);
  return path !== undefined && containers.has(pathKey(path));
}

/** A root type by its name, one below by the path of its parent and its key; none in a list. */
function pathOf(type: Y.AbstractType<unknown>): string[] | undefined {
  // eslint-disable-next-line no-underscore-dangle
  const item = type._item;
  if (item === null) {
    return [Y.findRootTypeKey(type)];
  }
  // In an array or a text it sits at a position, and a position is no key.
  if (item.parentSub === null || !(item.parent instanceof Y.AbstractType)) {
    return undefined;
  }
  const above = pathOf(item.parent);
  return above === undefined ? undefined : [...above, item.parentSub];
}

/** The key under which a path is looked up, as a set cannot compare arrays. */
function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

/** The item of the map, text or array a piece sits in; null at the top of the document. */
function placeOf(item: Y.Item): Y.Item | null {
  // Yjs offers no other way from a type to the item that holds it.
  // eslint-disable-next-line no-underscore-dangle
  return item.parent instanceof Y.AbstractType ? item.parent._item : null;
}

/** The newest value under the key of a piece; the values of one key form a chain to the right. */
function newestUnder(item: Y.Item): Y.Item {
  let current = item;
  while (current.right !== null) {
    current = current.right;
  }
  return current;
}

/** Whether the piece sat under a key that holds a living value again. */
function isReplaced(item: Y.Item): boolean {
  return item.parentSub !== null && !newestUnder(item).deleted;
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

/** The parts of a range in none of the others, which Yjs keeps sorted by clock. */
function outside(range: Range, others: readonly Range[]): Range[] {
  const end = range.clock + range.len;
  const parts: Range[] = [];
  let clock = range.clock;

  // Steps over every other range that reaches into this one.
  for (const other of others) {
    if (other.clock + other.len <= clock) {
      continue;
    }
    if (other.clock >= end) {
      break;
    }
    if (other.clock > clock) {
      parts.push({ clock, len: other.clock - clock });
    }
    clock = other.clock + other.len;
  }

  if (clock < end) {
    parts.push({ clock, len: end - clock });
  }
  return parts;
}

/** The items a stretch covers, each with the part of it inside the stretch. */
function itemsIn(
  structs: (Y.Item | Y.GC)[],
  part: Range,
): { item: Y.Item; clock: number; length: number }[] {
  const end = part.clock + part.len;
  const items: { item: Y.Item; clock: number; length: number }[] = [];
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
      items.push({ item: struct, clock, length: stop - clock });
    }
    clock = stop;
    index += 1;
  }
  return items;
}

/** Joins stretches that follow on one another in one unit and went alike; keeps the list short. */
function merged<T extends UnitStretch>(
  stretches: readonly T[],
  alike: (a: T, b: T) => boolean,
): T[] {
  const joined: T[] = [];

  for (const next of stretches) {
    const last = joined.at(-1);
    if (
      last !== undefined &&
      last.client === next.client &&
      last.clock + last.length === next.clock &&
      last.unit === next.unit &&
      alike(last, next)
    ) {
      joined[joined.length - 1] = { ...last, length: last.length + next.length };
    } else {
      joined.push(next);
    }
  }
  return joined;
}
