import { ObjectId, type Db, type Filter } from 'mongodb';

import type { Reference } from '../../model/anchor.ts';
import { RIGHTS, type Right } from '../../model/right.ts';
import { defined } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';
import { writeWithEvents, type NewEvent } from './events.ts';

/** The kinds the service keeps itself; only there can it enforce a right. */
export const SCOPE_KINDS = ['room', 'workpiece', 'task', 'comment', 'group'] as const;

export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** A place a grant holds at, and with it everything below that place. */
export interface Scope {
  kind: ScopeKind;
  id: ObjectId;
}

/** A group holds these rights at one place; without a scope, in the whole instance. */
export interface GrantRecord {
  _id: ObjectId;
  groupId: ObjectId;
  scope?: Scope;
  /** Replaced as a whole; who changed them, when and why is kept in events. */
  rights: Right[];
  createdAt: Date;
  createdBy: string;
}

export const grantsDefinition: CollectionDefinition = {
  name: 'grants',
  schema: {
    bsonType: 'object',
    required: ['groupId', 'rights', 'createdAt', 'createdBy'],
    properties: {
      groupId: { bsonType: 'objectId' },
      scope: {
        bsonType: 'object',
        required: ['kind', 'id'],
        description: 'left out, the grant holds in the whole instance',
        properties: {
          kind: { enum: [...SCOPE_KINDS] },
          id: { bsonType: 'objectId' },
        },
      },
      rights: {
        bsonType: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { enum: [...RIGHTS] },
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [
    // One grant per group and place, so changing rights replaces it instead of adding one.
    { key: { groupId: 1, 'scope.kind': 1, 'scope.id': 1 }, name: 'group_scope', unique: true },
    // Who holds what at a place, and what has to go when the place goes.
    { key: { 'scope.id': 1 }, name: 'scope_id' },
  ],
};

/** Whether a reference names a kind a grant can hold at. */
export function isScopeKind(kind: string): kind is ScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(kind);
}

export interface GrantChange {
  readonly groupId: ObjectId;
  /** Left out, the rights hold in the whole instance. */
  readonly scope?: Scope;
  readonly rights: readonly [Right, ...Right[]];
  readonly setBy: string;
  readonly reason?: string;
}

/** Sets what the group may do at the place, replacing what it had; answers whether that changed. */
export async function setGrant(db: Db, input: GrantChange, now = new Date()): Promise<boolean> {
  const rights = [...new Set(input.rights)];

  return writeWithEvents(
    db,
    async (session) => {
      // On insert the place comes from the filter, so it is written exactly as it is looked up.
      const result = await db
        .collection<GrantRecord>('grants')
        .updateOne(
          grantAt(input.groupId, input.scope),
          { $set: { rights }, $setOnInsert: { createdAt: now, createdBy: input.setBy } },
          { upsert: true, session },
        );

      return result.upsertedCount === 1 || result.modifiedCount === 1;
    },
    [grantEvent('grant-set', input, input.setBy, { rights })],
    now,
  );
}

export interface GrantRemoval {
  readonly groupId: ObjectId;
  readonly scope?: Scope;
  readonly removedBy: string;
  readonly reason?: string;
}

/** Takes the group's rights at the place away; answers whether it held any there. */
export async function removeGrant(db: Db, input: GrantRemoval, now = new Date()): Promise<boolean> {
  return writeWithEvents(
    db,
    async (session) => {
      const result = await db
        .collection<GrantRecord>('grants')
        .deleteOne(grantAt(input.groupId, input.scope), { session });

      return result.deletedCount === 1;
    },
    [grantEvent('grant-removed', input, input.removedBy)],
    now,
  );
}

/** Who holds what at one place; without a place, what holds in the whole instance. */
export async function grantsAt(db: Db, scope?: Scope): Promise<GrantRecord[]> {
  const filter = scope === undefined ? { scope: { $exists: false } } : atPlace(scope);

  return db.collection<GrantRecord>('grants').find(filter).toArray();
}

/** Every grant the group holds, wherever. */
export async function grantsOf(db: Db, groupId: ObjectId): Promise<GrantRecord[]> {
  return db.collection<GrantRecord>('grants').find({ groupId }).toArray();
}

/** The one grant of the group at the place, or the one it holds everywhere. */
export async function findGrant(
  db: Db,
  groupId: ObjectId,
  scope?: Scope,
): Promise<GrantRecord | null> {
  return db.collection<GrantRecord>('grants').findOne(grantAt(groupId, scope));
}

/** Every right these groups hold at one of these places or everywhere, each once, one query. */
export async function rightsHeld(
  db: Db,
  groupIds: readonly ObjectId[],
  places: readonly Scope[],
): Promise<Set<Right>> {
  if (groupIds.length === 0) {
    return new Set();
  }

  const found = await db
    .collection<GrantRecord>('grants')
    .find(
      {
        groupId: { $in: [...groupIds] },
        $or: [{ scope: { $exists: false } }, ...places.map(atPlace)],
      } as Filter<GrantRecord>,
      { projection: { rights: 1 } },
    )
    .toArray();

  return new Set(found.flatMap((grant) => grant.rights));
}

/** The one grant of a group at a place, or the one it holds everywhere. */
function grantAt(groupId: ObjectId, scope: Scope | undefined): Filter<GrantRecord> {
  return {
    groupId,
    ...(scope === undefined ? { scope: { $exists: false } } : atPlace(scope)),
  } as Filter<GrantRecord>;
}

/** Matches a scope by kind and id, as the unique index holds them. */
function atPlace(scope: Scope): Filter<GrantRecord> {
  return { 'scope.kind': scope.kind, 'scope.id': scope.id } as Filter<GrantRecord>;
}

/** The trace of a grant change at its place; one held everywhere has none, so at the group. */
function grantEvent(
  kind: string,
  input: { readonly groupId: ObjectId; readonly scope?: Scope; readonly reason?: string },
  by: string,
  extra: { readonly rights?: Right[] } = {},
): NewEvent {
  const anchor: Reference = input.scope ?? { kind: 'group', id: input.groupId };

  return {
    kind,
    createdBy: by,
    anchor,
    detail: { groupId: input.groupId, ...extra },
    ...defined({ reason: input.reason }),
  };
}
