import type { ObjectId } from 'mongodb';

import type { Author } from '../../db/collections/pseudonyms.ts';
import { defined } from '../../utils/optional.ts';
import type { Removal } from './deletions.ts';
import type { TraceTarget, Tracing } from './tracing.ts';

/** How long a bundle waits, in milliseconds. */
export interface BundleTimes {
  /** Without a further removal for this long, the bundle is written. */
  readonly pause: number;
  /** At the latest this long after its first removal. */
  readonly limit: number;
}

/** The removals of one person at one workpiece, gathered until a pause. */
interface Bundle {
  /** Who removed them, as the connection wrote them. */
  readonly person: Author;
  removals: Removal[];
  /** The last change stored before the first of the bundle; undefined if there was none. */
  readonly since: ObjectId | undefined;
  /** The last change of the bundle. */
  at: ObjectId;
  /** When its first removal came, so the limit counts from there. */
  readonly startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** What the hub asks of bundling. */
export interface Bundling {
  /** Adds what one stored change of the person removed and starts the pause anew. */
  add(
    target: TraceTarget,
    person: Author,
    removals: readonly Removal[],
    since: ObjectId | undefined,
    at: ObjectId,
  ): void;
  /** Writes every open bundle of the workpiece now and waits for those already being written. */
  flush(target: TraceTarget): Promise<void>;
}

/** Gathers removals per workpiece and person until a pause, so many small ones make one event. */
export function createBundling(tracing: Tracing, times: BundleTimes): Bundling {
  // Per workpiece as the hub holds it: the open bundle of each person, and writes still running.
  const open = new WeakMap<TraceTarget, Map<string, Bundle>>();
  const writing = new WeakMap<TraceTarget, Set<Promise<void>>>();

  /** Takes the bundle of the person out and writes it; tracing only logs a failure. */
  function write(target: TraceTarget, key: string): void {
    const bundles = open.get(target);
    const bundle = bundles?.get(key);
    if (bundles === undefined || bundle === undefined) {
      return;
    }
    clearTimeout(bundle.timer);
    bundles.delete(key);

    // Kept until written, so a flush can wait for it.
    const running = writing.get(target) ?? new Set<Promise<void>>();
    writing.set(target, running);
    const work = tracing.traceRemovals(
      target,
      bundle.removals,
      bundle.person,
      bundle.at,
      defined({ since: bundle.since }),
    );
    running.add(work);
    void work.then(() => running.delete(work));
  }

  /** Writes the bundle once the time is up. */
  function schedule(target: TraceTarget, key: string, delay: number) {
    return setTimeout(() => write(target, key), Math.max(0, delay));
  }

  return {
    add: (target, person, removals, since, at) => {
      const bundles = open.get(target) ?? new Map<string, Bundle>();
      open.set(target, bundles);
      const now = Date.now();
      // Open and anonymous removals of one person never share a bundle.
      const key = JSON.stringify([person.actorId, person.as ?? null]);
      const bundle = bundles.get(key);

      // The first removal opens the bundle and says where it starts.
      if (bundle === undefined) {
        bundles.set(key, {
          person,
          removals: [...removals],
          since,
          at,
          startedAt: now,
          timer: schedule(target, key, Math.min(times.pause, times.limit)),
        });
        return;
      }

      // Every further one moves the end on, but never past the limit.
      bundle.removals = [...bundle.removals, ...removals];
      bundle.at = at;
      clearTimeout(bundle.timer);
      bundle.timer = schedule(
        target,
        key,
        Math.min(times.pause, bundle.startedAt + times.limit - now),
      );
    },

    flush: async (target) => {
      // Every open bundle; a map still reaches the rest while writing takes each one out.
      for (const key of open.get(target)?.keys() ?? []) {
        write(target, key);
      }
      await Promise.all(writing.get(target) ?? []);
    },
  };
}
