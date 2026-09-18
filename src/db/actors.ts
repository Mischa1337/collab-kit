import type { Db } from 'mongodb';

import type { Actor } from '../auth/token.ts';

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

/**
 * Records that an actor was here. Creates the row on first contact and only moves
 * lastSeenAt afterwards, which is what D1.10 and D6.14 rest on.
 */
export async function touchActor(db: Db, actor: Actor, now = new Date()): Promise<ActorRecord> {
  const changes =
    actor.label === undefined ? { lastSeenAt: now } : { lastSeenAt: now, label: actor.label };

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
