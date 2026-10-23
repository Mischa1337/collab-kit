/** Who writes under which pseudonym: the flag on grants decides when it is written, and it stays. */

import type { Db, ObjectId } from 'mongodb';

import { subjectOf } from '../db/about.ts';
import { findComment } from '../db/collections/comments.ts';
import type { NewEvent } from '../db/collections/events.ts';
import { pseudonymOf, type Stamp } from '../db/collections/pseudonyms.ts';
import { findTask } from '../db/collections/tasks.ts';
import { eventKeysOf, keysOf, type Reader } from '../db/names.ts';
import type { Actor } from '../model/actor.ts';
import type { Reference } from '../model/anchor.ts';
import { defined } from '../utils/optional.ts';
import { anonymousAmong, may } from './access.ts';

/** A record a trace is written into or about, as far as stamping needs it. */
type Known = object & { readonly anonymous?: readonly Stamp[] };

/** Where a trace is written and what about: what decides its stamps. */
export interface StampContext {
  /** Where the flag is asked; with none, only grants of the whole instance count. */
  readonly places: readonly Reference[];
  /** What the pseudonyms belong to, as subjectOf finds it. */
  readonly about: Reference;
  /** The record it is written into or about; a key already in it stays as it stood there. */
  readonly known?: Known;
}

/** The stamps for these keys: what the record knows as it stood, the rest as the flag says now. */
export async function stampsFor(
  db: Db,
  keys: readonly string[],
  context: StampContext,
): Promise<Stamp[]> {
  const asked = [...new Set(keys)];
  const before = context.known?.anonymous ?? [];

  // Open or anonymous, a key in the record stays so, or a trace of it would give its pseudonym away.
  const inRecord = new Set(
    context.known === undefined
      ? []
      : [...keysOf(context.known), ...before.map((stamp) => stamp.key)],
  );
  const kept = before.filter((stamp) => asked.includes(stamp.key));
  const anonymous = await anonymousAmong(
    db,
    asked.filter((key) => !inRecord.has(key)),
    context.places,
  );

  const drawn = await Promise.all(
    [...anonymous].map(async (key) => ({ key, as: await pseudonymOf(db, context.about, key) })),
  );
  return [...kept, ...drawn];
}

/** The stamps of an event that brings none: asked at its anchor, a comment or task keeping its own. */
export async function eventStamps(db: Db, event: NewEvent): Promise<Stamp[]> {
  const keys = eventKeysOf(event);
  if (keys.length === 0) {
    return [];
  }

  const place: Reference = { kind: event.anchor.kind, id: event.anchor.id };
  const [about, known] = await Promise.all([subjectOf(db, place), recordAt(db, place)]);
  return stampsFor(db, keys, { places: [place], about, ...defined({ known }) });
}

/** Who reads an answer: sees their own key, and true keys behind pseudonyms where they manage. */
export function readerOf(db: Db, actor: Actor): Reader {
  // Asked once per place, however many entries of the answer lie there.
  const asked = new Map<string, Promise<boolean>>();

  return {
    actorId: actor.actorId,
    seesThrough: (place) => {
      const key = `${place.kind}:${place.id.toHexString()}`;
      const answer = asked.get(key) ?? may(db, actor, 'manage', place);
      asked.set(key, answer);
      return answer;
    },
  };
}

/** The key a filter must not find behind a stamp: somebody else's, where the reader does not manage. */
export async function unstampedFor(
  db: Db,
  actor: Actor,
  key: string | undefined,
  place: Reference,
): Promise<string | undefined> {
  if (key === undefined || key === actor.actorId) {
    return undefined;
  }
  // Otherwise the filter would say whose the pseudonym is that it finds.
  return (await may(db, actor, 'manage', place)) ? undefined : key;
}

/** Whether the actor writes anonymously at the place, as the flag says now; for GET /me/anonymous. */
export async function isAnonymousAt(
  db: Db,
  actorId: string,
  place: Reference | undefined,
): Promise<boolean> {
  return (await anonymousAmong(db, [actorId], place === undefined ? [] : [place])).has(actorId);
}

/** The pseudonym the actor writes under at the workpiece, or undefined while openly. */
export async function writesAs(
  db: Db,
  actorId: string,
  workpieceId: ObjectId,
): Promise<string | undefined> {
  const workpiece: Reference = { kind: 'workpiece', id: workpieceId };

  const anonymous = await anonymousAmong(db, [actorId], [workpiece]);
  return anonymous.has(actorId) ? pseudonymOf(db, workpiece, actorId) : undefined;
}

/** The comment or task an event hangs on, whose keys keep in its events how they stand in it. */
async function recordAt(db: Db, place: Reference): Promise<Known | undefined> {
  if (place.kind === 'comment') {
    return (await findComment(db, place.id)) ?? undefined;
  }
  if (place.kind === 'task') {
    return (await findTask(db, place.id)) ?? undefined;
  }
  return undefined;
}
