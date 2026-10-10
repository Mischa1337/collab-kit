import { ObjectId, type Db } from 'mongodb';

import {
  latestEvent,
  latestMerge,
  recordEvent,
  type EventRecord,
} from '../../db/collections/events.ts';
import { addToRoom } from '../../db/collections/rooms.ts';
import { copyUpdates, readUpdatesSince, readUpdatesUntil } from '../../db/collections/updates.ts';
import {
  createWorkpiece,
  findWorkpiece,
  type WorkpieceRecord,
} from '../../db/collections/workpieces.ts';
import { WHOLE } from '../../model/anchor.ts';
import { defined } from '../../utils/optional.ts';
import type { WorkpieceHub } from '../hub/types.ts';

/** What a person gives a fork: its name, where to fork, where to put it and why. */
export interface NewFork {
  readonly name: string;
  readonly createdBy: string;
  /** The last change to take along; left out, whatever is stored by now. */
  readonly at?: ObjectId;
  readonly roomId?: ObjectId;
  readonly reason?: string;
}

/** What a person gives a merge: where the changes come from and why. */
export interface NewMerge {
  readonly from: ObjectId;
  readonly createdBy: string;
  readonly reason?: string;
}

/** Forks a workpiece: its history up to a point, copied under the same authors, then the fork. */
export async function forkWorkpiece(
  db: Db,
  hub: WorkpieceHub,
  sourceId: ObjectId,
  input: NewFork,
): Promise<WorkpieceRecord> {
  const source = await findWorkpiece(db, sourceId);
  if (source === null) {
    throw new Error(`unknown workpiece ${sourceId.toHexString()}`);
  }

  // Up to the point asked for, or what is stored by now, a change still being written included.
  const at = input.at ?? (await hub.storedUpTo(sourceId));
  const rows = at === undefined ? [] : await readUpdatesUntil(db, sourceId, at);

  // The history first: should it break off, it lies there without a workpiece nobody sees.
  const id = new ObjectId();
  const copies = await copyUpdates(db, rows, id);
  const fork = await createWorkpiece(db, {
    id,
    name: input.name,
    createdBy: input.createdBy,
    contract: source.contract,
    units: source.units,
    forkOf: { id: sourceId, ...defined({ at }) },
  });
  if (input.roomId !== undefined) {
    await addToRoom(db, input.roomId, { kind: 'workpiece', id, addedBy: input.createdBy });
  }

  // Only at the fork: the group of the original need not hear of a private copy.
  await recordEvent(db, {
    kind: 'workpiece-forked',
    createdBy: input.createdBy,
    anchor: { kind: 'workpiece', id },
    ...defined({ at: copies.at(-1)?._id, reason: input.reason }),
    detail: { from: sourceId, ...defined({ fromAt: at }) },
  });
  return fork;
}

/** Brings into a workpiece what another one has beyond the mark, through the hub as if typed. */
export async function mergeWorkpiece(
  db: Db,
  hub: WorkpieceHub,
  targetId: ObjectId,
  input: NewMerge,
): Promise<EventRecord> {
  const mark = await markOf(db, input.from, targetId);
  const rows = await readUpdatesSince(db, input.from, mark);

  return hub.merge(targetId, {
    from: input.from,
    rows,
    createdBy: input.createdBy,
    ...defined({ upTo: rows.at(-1)?._id ?? mark, reason: input.reason }),
  });
}

/** The last change of the source the target holds already; undefined to start from the start. */
async function markOf(db: Db, from: ObjectId, target: ObjectId): Promise<ObjectId | undefined> {
  // Merged before: from where the last one stopped.
  const last = await latestMerge(db, target, from);
  if (last !== null) {
    const upTo = last.detail?.['upTo'] as unknown;
    return upTo instanceof ObjectId ? upTo : undefined;
  }

  const [source, targetRecord] = await Promise.all([
    findWorkpiece(db, from),
    findWorkpiece(db, target),
  ]);
  // Into a fork from its original: the original up to where it forked is there already.
  if (targetRecord?.forkOf?.id.equals(from) === true) {
    return targetRecord.forkOf.at;
  }
  // Back from a fork into its original: the copies are there already, the fork says up to which.
  if (source?.forkOf?.id.equals(target) === true) {
    const forked = await latestEvent(db, {
      anchor: { kind: 'workpiece', id: from, unit: WHOLE },
      kind: 'workpiece-forked',
    });
    return forked?.at;
  }
  // Without a shared past: everything, and Yjs skips what the target knows anyway.
  return undefined;
}
