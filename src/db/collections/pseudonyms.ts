import { randomInt } from 'node:crypto';

import { MongoServerError, ObjectId, type Db, type Document } from 'mongodb';

import { PSEUDONYM_PREFIX } from '../../model/actor.ts';
import { referenceProperties, type Reference } from '../../model/anchor.ts';
import { defined } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';

/** A key that wrote anonymously, and the pseudonym it shows as there. */
export interface Stamp {
  key: string;
  as: string;
}

/** Database schema of the stamps a trace carries, for collections that embed them. */
export const stampsSchema: Document = {
  bsonType: 'array',
  minItems: 1,
  description: 'the keys that wrote anonymously, each with its pseudonym; absent if none did',
  items: {
    bsonType: 'object',
    required: ['key', 'as'],
    properties: { key: { bsonType: 'string' }, as: { bsonType: 'string' } },
  },
};

/** A person as a change names them: the key, and the pseudonym if they wrote anonymously. */
export interface Author {
  readonly actorId: string;
  readonly as?: string;
}

/** The pseudonym of one key about one thing; drawn once, so the person stays the same there. */
export interface PseudonymRecord {
  _id: ObjectId;
  /** What it belongs to; about another thing the same key has another one. */
  about: Reference;
  key: string;
  as: string;
}

export const pseudonymsDefinition: CollectionDefinition = {
  name: 'pseudonyms',
  schema: {
    bsonType: 'object',
    required: ['about', 'key', 'as'],
    properties: {
      about: {
        bsonType: 'object',
        required: ['kind', 'id'],
        description: 'the thing the pseudonym belongs to',
        properties: referenceProperties,
      },
      key: { bsonType: 'string' },
      as: { bsonType: 'string', description: 'anon- and four digits' },
    },
  },
  indexes: [
    // One pseudonym per key and thing, and none twice about the same thing.
    { key: { 'about.id': 1, key: 1 }, name: 'about_key', unique: true },
    { key: { 'about.id': 1, as: 1 }, name: 'about_as', unique: true },
  ],
};

/** How often a taken pseudonym is drawn again before giving up; there are 10,000 per thing. */
const MAX_DRAWS = 50;

/** The pseudonym of the key about the thing, drawn on first use; never in a transaction. */
export async function pseudonymOf(db: Db, about: Reference, key: string): Promise<string> {
  const pseudonyms = db.collection<PseudonymRecord>('pseudonyms');

  /* eslint-disable no-await-in-loop */
  for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
    const found = await pseudonyms.findOne<Pick<PseudonymRecord, 'as'>>(
      { 'about.id': about.id, key },
      { projection: { _id: 0, as: 1 } },
    );
    if (found !== null) {
      return found.as;
    }

    const as = drawPseudonym();
    try {
      await pseudonyms.insertOne({
        _id: new ObjectId(),
        about: { kind: about.kind, id: about.id },
        key,
        as,
      });
      return as;
    } catch (error) {
      // Taken, by this key meanwhile, which the next round finds, or by another, so drawn anew.
      // Inside a transaction the duplicate would end it, which is why no session is passed.
      if (!(error instanceof MongoServerError && error.code === 11000)) {
        throw error;
      }
    }
  }
  /* eslint-enable no-await-in-loop */

  throw new Error(`no pseudonym left about ${about.kind} ${about.id.toHexString()}`);
}

/** Gives a fork the pseudonyms of its source, so its copied history keeps them and none repeats. */
export async function copyPseudonyms(db: Db, from: Reference, to: Reference): Promise<void> {
  const pseudonyms = db.collection<PseudonymRecord>('pseudonyms');
  const found = await pseudonyms.find({ 'about.id': from.id }).toArray();

  if (found.length > 0) {
    await pseudonyms.insertMany(
      found.map(({ key, as }) => ({
        _id: new ObjectId(),
        about: { kind: to.kind, id: to.id },
        key,
        as,
      })),
    );
  }
}

/** The stamps of these authors, each key once; whoever wrote openly has none. */
export function stampsOf(authors: readonly Author[]): Stamp[] {
  const stamps = new Map<string, Stamp>();

  for (const { actorId, as } of authors) {
    if (as !== undefined && !stamps.has(actorId)) {
      stamps.set(actorId, { key: actorId, as });
    }
  }
  return [...stamps.values()];
}

/** The author of something stored: its key, with the pseudonym if it is stamped. */
export function authorOf(stored: {
  readonly createdBy: string;
  readonly anonymous?: readonly Stamp[];
}): Author {
  const as = stored.anonymous?.find((stamp) => stamp.key === stored.createdBy)?.as;
  return { actorId: stored.createdBy, ...defined({ as }) };
}

/** The field anonymous as a record keeps it: only when somebody in it wrote anonymously. */
export function stampField(stamps: readonly Stamp[]): { anonymous?: Stamp[] } {
  return stamps.length === 0 ? {} : { anonymous: [...stamps] };
}

/** anon- and four digits, drawn alike for everyone, so a pseudonym tells nothing of its key. */
function drawPseudonym(): string {
  return `${PSEUDONYM_PREFIX}${String(randomInt(10_000)).padStart(4, '0')}`;
}
