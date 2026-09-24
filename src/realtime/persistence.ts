import type { Db, ObjectId } from 'mongodb';
import * as Y from 'yjs';

import { findWorkpiece, foldState } from '../db/collections/workpieces.ts';
import { appendUpdate, readUpdatesSince } from '../db/collections/updates.ts';
import { defined } from '../utils/optional.ts';

/**
 * A workpiece in memory and how far it is kept. The truth stays in the database: this
 * is only the working copy, and everything written for it runs through one queue.
 */
export interface WorkingCopy {
  readonly workpieceId: ObjectId;
  readonly doc: Y.Doc;
  /** Writes run one after another, so the stored order matches the order of arrival. */
  queue: Promise<void>;
  /** The newest update written for this workpiece, the cut for the next folding. */
  lastUpdateId?: ObjectId;
  /** What stateThrough holds in the database, as far as this process knows. */
  foldedThrough?: ObjectId;
  /** Updates that have arrived since the last folding. */
  sinceFold: number;
}

/**
 * Rebuilds the working copy from the folded state plus every change after it. Nothing
 * listens to the Y.Doc yet, so replaying the history does not store it a second time.
 */
export async function loadWorkingCopy(db: Db, workpieceId: ObjectId): Promise<WorkingCopy> {
  const record = await findWorkpiece(db, workpieceId);

  if (record === null) {
    throw new Error(`unknown workpiece ${workpieceId.toHexString()}`);
  }

  const doc = new Y.Doc();
  if (record.state !== undefined) {
    Y.applyUpdate(doc, new Uint8Array(record.state.buffer));
  }

  // Everything the shortcut does not cover yet. A workpiece that was never folded
  // starts from nothing and reads its whole history, which is just as correct.
  const pending = await readUpdatesSince(db, workpieceId, record.stateThrough);
  for (const row of pending) {
    Y.applyUpdate(doc, new Uint8Array(row.update.buffer));
  }

  return {
    workpieceId,
    doc,
    queue: Promise.resolve(),
    sinceFold: pending.length,
    ...defined({
      lastUpdateId: pending.at(-1)?._id ?? record.stateThrough,
      foldedThrough: record.stateThrough,
    }),
  };
}

/**
 * Runs work behind everything queued before it and hands back its result. A failure
 * reaches whoever queued the work and never holds up what is queued after it.
 */
export function enqueue<T>(
  copy: Pick<WorkingCopy, 'queue'>,
  work: () => T | Promise<T>,
): Promise<T> {
  const run = copy.queue.then(work);
  copy.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Keeps one change and counts it towards the next folding. Runs inside the queue. */
export async function storeUpdate(
  db: Db,
  copy: WorkingCopy,
  update: Uint8Array,
  actorId: string,
): Promise<void> {
  const record = await appendUpdate(db, { workpieceId: copy.workpieceId, update, actorId });

  copy.lastUpdateId = record._id;
  copy.sinceFold += 1;
}

/**
 * Takes the state from memory and writes it as the new shortcut. Runs inside the
 * queue or after it has drained, so everything up to lastUpdateId has been stored and
 * is contained in it.
 *
 * A change that arrives while this runs lands behind the cut and is applied on top
 * at the next load. Applying it twice is harmless in Yjs.
 */
export async function foldNow(db: Db, copy: WorkingCopy): Promise<boolean> {
  const through = copy.lastUpdateId;

  if (through === undefined) {
    return false;
  }
  if (copy.foldedThrough !== undefined && through.equals(copy.foldedThrough)) {
    return false;
  }

  const written = await foldState(db, {
    workpieceId: copy.workpieceId,
    state: Y.encodeStateAsUpdate(copy.doc),
    through,
    ...defined({ expected: copy.foldedThrough }),
  });

  if (written) {
    copy.foldedThrough = through;
    copy.sinceFold = 0;
  }
  return written;
}
