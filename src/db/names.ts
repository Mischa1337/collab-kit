import type { Db, ObjectId } from 'mongodb';

import type { Reference, ReferenceKind } from '../model/anchor.ts';
import { findNames } from './collections/actors.ts';
import { SERVICE_KINDS } from './collections/events.ts';
import type { Stamp } from './collections/pseudonyms.ts';

/** Key to name for the actors in one object; a key without a stored name is left out. */
export type Names = Record<string, string>;

/** An object as it goes out: its stamps gone, with the names of the actors in it as far as known. */
export type Named<T> = (T extends { anonymous?: readonly Stamp[] } ? Omit<T, 'anonymous'> : T) & {
  names?: Names;
};

/** Where an object of the service holds actor keys. */
export type KeysOf = (value: object) => string[];

/** What a key shows as to the reader: its pseudonym where it is masked for them. */
type Swap = (key: string) => string;

/** Where an object holds actor keys, to find them and to swap them for what the reader may see. */
export interface Shape {
  readonly keys: KeysOf;
  readonly swap: (value: object, swap: Swap) => object;
}

/** Who reads an answer: their own key always shows, others' true keys only where they manage. */
export interface Reader {
  readonly actorId: string;
  /** Whether manage at the place lets them see the true keys behind its pseudonyms. */
  seesThrough(place: Reference): Promise<boolean>;
}

/** How a list is named: where its keys are and where each entry lies. */
export interface Naming<T> {
  /** Left out, an object of the service; EVENTS reads the detail the service wrote too. */
  readonly shape?: Shape;
  /** Where manage counts for an entry; left out, a stamp is lifted only for the reader's own key. */
  readonly placeOf?: (entry: T) => Reference;
}

/** The fields the service writes actor keys into; free ones such as body or detail stay unread. */
const KEY_FIELDS = ['actorId', 'createdBy', 'deletedBy', 'members', 'affects'] as const;

/** The actor keys in an object of the service, as KEY_FIELDS and its persons given it name them. */
export function keysOf(value: object): string[] {
  const fields = value as Record<string, unknown>;
  const assignees = Array.isArray(fields['assignees']) ? (fields['assignees'] as unknown[]) : [];

  return [...KEY_FIELDS.flatMap((name) => keysIn(fields[name])), ...assignees.flatMap(personIn)];
}

/** As keysOf, and in detail where the service wrote it, never in a detail of the tool. */
export function eventKeysOf(event: object): string[] {
  const detail = serviceDetail(event);

  // member-* name the person in actorId, assignee-* carry the assignee itself.
  return detail === undefined
    ? keysOf(event)
    : [...keysOf(event), ...keysIn(detail['actorId']), ...personIn(detail)];
}

/** Objects of the service: their keys in KEY_FIELDS and in the persons given a task. */
export const RECORDS: Shape = { keys: keysOf, swap: swapKeys };

/** Events: as RECORDS, and in the detail the service wrote. */
export const EVENTS: Shape = { keys: eventKeysOf, swap: swapEventKeys };

/** Each entry is its own place: a comment, a task or a workpiece by its _id. */
export function itself(kind: ReferenceKind): (entry: { readonly _id: ObjectId }) => Reference {
  return (entry) => ({ kind, id: entry._id });
}

/** Each event lies at its anchor, without the unit. */
export function atAnchor(entry: { readonly anchor: Reference }): Reference {
  return { kind: entry.anchor.kind, id: entry.anchor.id };
}

/** Events, each masked where it is anchored. */
export const EVENTS_AT_ANCHOR = { shape: EVENTS, placeOf: atAnchor } as const;

/** Masks and names one object or each in a list, with one lookup of names for all (D6.1). */
export async function withNames<T extends object>(
  db: Db,
  value: readonly T[],
  reader: Reader,
  naming?: Naming<T>,
): Promise<Named<T>[]>;
export async function withNames<T extends object>(
  db: Db,
  value: T,
  reader: Reader,
  naming?: Naming<T>,
): Promise<Named<T>>;
export async function withNames<T extends object>(
  db: Db,
  value: T | null,
  reader: Reader,
  naming?: Naming<T>,
): Promise<Named<T> | null>;
export async function withNames<T extends object>(
  db: Db,
  value: T | readonly T[] | null,
  reader: Reader,
  naming: Naming<T> = {},
): Promise<unknown> {
  if (value === null) {
    return null;
  }

  const list: readonly T[] = Array.isArray(value) ? value : [value as T];
  const shown = await Promise.all(list.map((entry) => shownTo(entry, reader, naming)));
  const all = [...new Set(shown.flatMap(({ open }) => open))];

  // Nobody in it, so nothing to look up.
  const found = new Map<string, string>();
  if (all.length > 0) {
    for (const { _id, label } of await findNames(db, all)) {
      if (label !== undefined) {
        found.set(_id, label);
      }
    }
  }

  // Whoever may see the object may see the names in it, but none behind a pseudonym.
  const named = shown.map(({ entry, open }) => {
    const known = [...new Set(open)].filter((key) => found.has(key));
    const names = Object.fromEntries(known.map((key) => [key, found.get(key)]));
    return known.length === 0 ? entry : Object.assign({}, entry, { names });
  });
  return Array.isArray(value) ? named : named[0];
}

/** One entry as the reader may see it, without its stamps, and the true keys still in it. */
async function shownTo<T extends object>(
  entry: T,
  reader: Reader,
  naming: Naming<T>,
): Promise<{ entry: object; open: string[] }> {
  const shape = naming.shape ?? RECORDS;
  // Stamps are a list; the flag of a grant goes by the same name and stays.
  const fields = entry as Record<string, unknown>;
  const stamps = Array.isArray(fields['anonymous']) ? (fields['anonymous'] as Stamp[]) : [];
  const rest = Object.fromEntries(
    Object.entries(fields).filter(([name, field]) => name !== 'anonymous' || !Array.isArray(field)),
  );

  // The reader's own key always shows; the others only to whoever manages where it lies.
  const others = stamps.filter((stamp) => stamp.key !== reader.actorId);
  const through =
    others.length > 0 &&
    naming.placeOf !== undefined &&
    (await reader.seesThrough(naming.placeOf(entry)));
  const masks = new Map(through ? [] : others.map((stamp) => [stamp.key, stamp.as]));

  const open = shape.keys(rest).filter((key) => !masks.has(key));
  if (masks.size === 0) {
    return { entry: rest, open };
  }
  return { entry: shape.swap(rest, (key) => masks.get(key) ?? key), open };
}

/** An object with the keys in KEY_FIELDS and in the persons given it swapped. */
function swapKeys(value: object, swap: Swap): object {
  const fields = value as Record<string, unknown>;
  const swapped: Record<string, unknown> = { ...fields };

  for (const name of KEY_FIELDS) {
    if (fields[name] !== undefined) {
      swapped[name] = swapIn(fields[name], swap);
    }
  }
  if (Array.isArray(fields['assignees'])) {
    swapped['assignees'] = (fields['assignees'] as unknown[]).map((entry) =>
      swapPerson(entry, swap),
    );
  }
  return swapped;
}

/** As swapKeys, and in the detail the service wrote, where eventKeysOf finds keys too. */
function swapEventKeys(event: object, swap: Swap): object {
  const swapped = swapKeys(event, swap) as Record<string, unknown>;
  const detail = serviceDetail(event);

  if (detail !== undefined) {
    const member =
      detail['actorId'] === undefined ? {} : { actorId: swapIn(detail['actorId'], swap) };
    swapped['detail'] = swapPerson({ ...detail, ...member }, swap);
  }
  return swapped;
}

/** The detail of an event if the service wrote it, the only detail that may hold keys. */
function serviceDetail(event: object): Record<string, unknown> | undefined {
  const fields = event as Record<string, unknown>;
  const detail = fields['detail'];

  return typeof fields['kind'] === 'string' &&
    SERVICE_KINDS.has(fields['kind']) &&
    typeof detail === 'object' &&
    detail !== null
    ? (detail as Record<string, unknown>)
    : undefined;
}

/** A key or a list of keys as the service stores them; anything else holds none. */
function keysIn(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return [raw];
  }
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** A key or a list of keys with each swapped; anything else stays as it is. */
function swapIn(raw: unknown, swap: Swap): unknown {
  if (typeof raw === 'string') {
    return swap(raw);
  }
  return Array.isArray(raw)
    ? raw.map((entry: unknown) => (typeof entry === 'string' ? swap(entry) : entry))
    : raw;
}

/** The key of an assignee, if it is a person and not a group. */
function personIn(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) {
    return [];
  }
  const { kind, id } = raw as Record<string, unknown>;
  return kind === 'actor' && typeof id === 'string' ? [id] : [];
}

/** An assignee with the key of its person swapped; a group stays as it is. */
function swapPerson(raw: unknown, swap: Swap): unknown {
  const [key] = personIn(raw);
  return key === undefined ? raw : { ...(raw as Record<string, unknown>), id: swap(key) };
}
