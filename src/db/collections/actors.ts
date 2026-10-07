import type { Db } from 'mongodb';

import type { Actor } from '../../model/actor.ts';
import { defined } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';

/** What the service keeps about an actor: no account or profile, the key comes from the token. */
export interface ActorRecord {
  _id: string;
  /** Cached display name, so old changes stay readable without asking the tool. */
  label?: string;
  lastSeenAt: Date;
}

export const actorsDefinition: CollectionDefinition = {
  name: 'actors',
  schema: {
    bsonType: 'object',
    required: ['_id', 'lastSeenAt'],
    properties: {
      _id: {
        bsonType: 'string',
        description: 'the key from the token claim set by ACTOR_CLAIM, never issued by the service',
      },
      label: { bsonType: 'string' },
      lastSeenAt: { bsonType: 'date' },
    },
  },
};

/** The stored names of these actors; one never seen is simply missing. */
export async function findNames(
  db: Db,
  actorIds: readonly string[],
): Promise<Pick<ActorRecord, '_id' | 'label'>[]> {
  return db
    .collection<ActorRecord>('actors')
    .find<Pick<ActorRecord, '_id' | 'label'>>(
      { _id: { $in: [...actorIds] } },
      { projection: { label: 1 } },
    )
    .toArray();
}

/** Records a visit: creates the row on first contact and moves lastSeenAt every time (D1.10). */
export async function touchActor(db: Db, actor: Actor, now = new Date()): Promise<ActorRecord> {
  const changes = { lastSeenAt: now, ...defined({ label: actor.label }) };

  const record = await db
    .collection<ActorRecord>('actors')
    .findOneAndUpdate(
      { _id: actor.actorId },
      { $set: changes },
      { upsert: true, returnDocument: 'after' },
    );

  if (record === null) {
    throw new Error(`could not record the actor ${actor.actorId}`);
  }
  return record;
}
