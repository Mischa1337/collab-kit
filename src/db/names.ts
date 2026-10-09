import type { Db } from 'mongodb';

import { findNames } from './collections/actors.ts';
import { SERVICE_KINDS } from './collections/events.ts';

/** Key to name for the actors in one object; a key without a stored name is left out. */
export type Names = Record<string, string>;

/** An object as it goes out: with the names of the actors in it, as far as any are known. */
export type Named<T> = T & { names?: Names };

/** Where an object of the service holds actor keys. */
export type KeysOf = (value: object) => string[];

/** The fields the service writes actor keys into; free ones such as body or detail stay unread. */
export function keysOf(value: object): string[] {
  const fields = value as Record<string, unknown>;
  const assignees = Array.isArray(fields['assignees']) ? (fields['assignees'] as unknown[]) : [];

  return [
    ...keysIn(fields['actorId']),
    ...keysIn(fields['createdBy']),
    ...keysIn(fields['deletedBy']),
    ...keysIn(fields['members']),
    ...keysIn(fields['affects']),
    ...assignees.flatMap(personIn),
  ];
}

/** As keysOf, and in detail where the service wrote it, never in a detail of the tool. */
export function eventKeysOf(event: object): string[] {
  const fields = event as Record<string, unknown>;
  const detail = fields['detail'];
  const own =
    typeof fields['kind'] === 'string' &&
    SERVICE_KINDS.has(fields['kind']) &&
    typeof detail === 'object' &&
    detail !== null;

  // member-* name the person in actorId, assignee-* carry the assignee itself.
  return own
    ? [
        ...keysOf(event),
        ...keysIn((detail as Record<string, unknown>)['actorId']),
        ...personIn(detail),
      ]
    : keysOf(event);
}

/** Adds the names to one object or to each in a list, with one lookup for all (D6.1). */
export async function withNames<T extends object>(
  db: Db,
  value: readonly T[],
  keys?: KeysOf,
): Promise<Named<T>[]>;
export async function withNames<T extends object>(
  db: Db,
  value: T,
  keys?: KeysOf,
): Promise<Named<T>>;
export async function withNames<T extends object>(
  db: Db,
  value: T | null,
  keys?: KeysOf,
): Promise<Named<T> | null>;
export async function withNames(
  db: Db,
  value: object | readonly object[] | null,
  keys: KeysOf = keysOf,
): Promise<unknown> {
  if (value === null) {
    return null;
  }

  const list: readonly object[] = Array.isArray(value) ? value : [value];
  const keysPer = list.map((entry) => [...new Set(keys(entry))]);
  const all = [...new Set(keysPer.flat())];

  // Nobody in it, so nothing to look up.
  const found = new Map<string, string>();
  if (all.length > 0) {
    for (const { _id, label } of await findNames(db, all)) {
      if (label !== undefined) {
        found.set(_id, label);
      }
    }
  }

  // Whoever may see the object may see the names in it; none known, no names at all.
  const named = list.map((entry, index) => {
    const known = (keysPer[index] ?? []).filter((key) => found.has(key));
    const names = Object.fromEntries(known.map((key) => [key, found.get(key)]));
    return known.length === 0 ? entry : Object.assign({}, entry, { names });
  });
  return Array.isArray(value) ? named : named[0];
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

/** The key of an assignee, if it is a person and not a group. */
function personIn(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) {
    return [];
  }
  const { kind, id } = raw as Record<string, unknown>;
  return kind === 'actor' && typeof id === 'string' ? [id] : [];
}
