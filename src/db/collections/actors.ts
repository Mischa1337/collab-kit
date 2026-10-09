import type { Db } from 'mongodb';
import type { Logger } from 'pino';

import type { Actor } from '../../model/actor.ts';
import type { CollectionDefinition } from '../apply.ts';

/** What the service keeps about an actor: no account or profile, the key comes from the token. */
export interface ActorRecord {
  _id: string;
  /** Cached display name, so old changes stay readable without asking the tool. */
  label?: string;
}

export const actorsDefinition: CollectionDefinition = {
  name: 'actors',
  schema: {
    bsonType: 'object',
    required: ['_id'],
    properties: {
      _id: {
        bsonType: 'string',
        description: 'the key from the token claim set by ACTOR_CLAIM, never issued by the service',
      },
      label: { bsonType: 'string' },
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

/** Keeps the name a token carried, creating the row on first contact (D6.1). */
export async function noteActor(db: Db, actorId: string, label: string): Promise<void> {
  await db
    .collection<ActorRecord>('actors')
    .updateOne({ _id: actorId }, { $set: { label } }, { upsert: true });
}

/** Keeps the name of whoever comes with a token; never fails the caller. */
export type ActorNotes = (actor: Actor) => Promise<void>;

/** One per process, shared by routes and hub, so a name is written once and not per request. */
export function createActorNotes(db: Db, logger: Logger): ActorNotes {
  // The name last written per key; a key gets in only once its write went through.
  const written = new Map<string, string>();

  return async ({ actorId, label }) => {
    // Without a name there is nothing worth a row, and an unchanged one is stored already.
    if (label === undefined || written.get(actorId) === label) {
      return;
    }

    try {
      await noteActor(db, actorId, label);
      written.set(actorId, label);
    } catch (error) {
      // Not remembered, so the next request tries again.
      logger.error({ err: error }, 'could not record the actor');
    }
  };
}
