import type { Db } from 'mongodb';

import type { Actor } from '../../model/actor.ts';
import { defined } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';

/**
 * What the service keeps about an actor. No account, no password, no profile: the key
 * comes from the token, everything else is state the service itself needs.
 */
export interface ActorRecord {
  _id: string;
  /** Cached display name, so old changes stay readable without asking the tool. */
  label?: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export const actorsDefinition: CollectionDefinition = {
  name: 'actors',
  schema: {
    bsonType: 'object',
    required: ['_id', 'firstSeenAt'],
    properties: {
      _id: {
        bsonType: 'string',
        description: 'the sub of the token, the service never issues a key of its own',
      },
      label: { bsonType: 'string' },
      firstSeenAt: { bsonType: 'date' },
      lastSeenAt: { bsonType: 'date' },
    },
  },
};

/**
 * Records that an actor was here. Creates the row on first contact and only moves
 * lastSeenAt afterwards, which is what D1.10 and D6.14 rest on.
 */
export async function touchActor(db: Db, actor: Actor, now = new Date()): Promise<ActorRecord> {
  const changes = { lastSeenAt: now, ...defined({ label: actor.label }) };

  const record = await db
    .collection<ActorRecord>('actors')
    .findOneAndUpdate(
      { _id: actor.actorId },
      { $set: changes, $setOnInsert: { firstSeenAt: now } },
      { upsert: true, returnDocument: 'after' },
    );

  if (record === null) {
    throw new Error(`could not record the actor ${actor.actorId}`);
  }
  return record;
}
