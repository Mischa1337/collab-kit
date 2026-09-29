import type { Db, ObjectId } from 'mongodb';
import * as Y from 'yjs';

import { findWorkpieceWithFold, foldState } from '../db/collections/workpieces.ts';
import { appendUpdate, readUpdatesSince } from '../db/collections/updates.ts';
import { defined } from '../utils/optional.ts';

/** How far a workpiece is stored, and the queue its writes run through. */
export interface Stored {
  readonly workpieceId: ObjectId;
  /** Writes run one after another, so the stored order matches the order of arrival. */
  queue: Promise<void>;
  /** The newest update written for this workpiece, the cut for the next folding. */
  lastUpdateId?: ObjectId;
  /** What fold.upToUpdateId holds in the database, as far as this process knows. */
  foldedUpToUpdateId?: ObjectId;
  /** Updates stored since a fold was last tried, so a failing fold is not retried each time. */
  updatesSinceFoldAttempt: number;
}

/** Rebuilds the workpiece from its folded state plus every change after it. */
export async function loadWorkpiece(
  db: Db,
  workpieceId: ObjectId,
): Promise<{ readonly doc: Y.Doc; readonly stored: Stored }> {
  const record = await findWorkpieceWithFold(db, workpieceId);

  if (record === null) {
    throw new Error(`unknown workpiece ${workpieceId.toHexString()}`);
  }

  // Starts from the folded state, if there is one.
  const doc = new Y.Doc();
  if (record.fold !== undefined) {
    Y.applyUpdate(doc, new Uint8Array(record.fold.state.buffer));
  }

  // Then every change the fold does not cover; never folded means the whole history.
  const afterFold = await readUpdatesSince(db, workpieceId, record.fold?.upToUpdateId);
  for (const row of afterFold) {
    Y.applyUpdate(doc, new Uint8Array(row.bytes.buffer));
  }

  // How far it is stored: the newest change, and how far the fold reaches.
  const stored: Stored = {
    workpieceId,
    queue: Promise.resolve(),
    updatesSinceFoldAttempt: afterFold.length,
    ...defined({
      lastUpdateId: afterFold.at(-1)?._id ?? record.fold?.upToUpdateId,
      foldedUpToUpdateId: record.fold?.upToUpdateId,
    }),
  };

  return { doc, stored };
}

/** Runs work after everything queued before it; a failure reaches only whoever queued it. */
export function enqueue<T>(stored: Pick<Stored, 'queue'>, work: () => T | Promise<T>): Promise<T> {
  // Chained behind the last work, whatever became of it.
  const run = stored.queue.then(work);
  // The queue itself never fails, so one failure does not hold up the rest.
  stored.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Keeps one change and counts it towards the next folding. Runs inside the queue. */
export async function storeUpdate(
  db: Db,
  stored: Stored,
  update: Uint8Array,
  createdBy: string,
): Promise<void> {
  const record = await appendUpdate(db, {
    workpieceId: stored.workpieceId,
    bytes: update,
    createdBy,
  });

  // The newest stored change is the cut for the next fold.
  stored.lastUpdateId = record._id;
  stored.updatesSinceFoldAttempt += 1;
}

/** Writes the state from memory as the new shortcut; runs in the queue or after it drained. */
export async function foldNow(db: Db, stored: Stored, doc: Y.Doc): Promise<boolean> {
  const upToUpdateId = stored.lastUpdateId;

  // Nothing stored yet, or nothing new since the last fold.
  if (upToUpdateId === undefined) {
    return false;
  }
  if (stored.foldedUpToUpdateId !== undefined && upToUpdateId.equals(stored.foldedUpToUpdateId)) {
    return false;
  }

  // Counted from the attempt, so a fold that keeps failing waits as long as the first one did.
  stored.updatesSinceFoldAttempt = 0;

  // May hold changes not stored yet; they lie beyond the cut, and applying twice is harmless.
  const written = await foldState(db, {
    workpieceId: stored.workpieceId,
    state: Y.encodeStateAsUpdate(doc),
    upToUpdateId,
    ...defined({ expected: stored.foldedUpToUpdateId }),
  });

  // Only a fold that was written moves the mark; losing the race to another changes nothing.
  if (written) {
    stored.foldedUpToUpdateId = upToUpdateId;
  }
  return written;
}
