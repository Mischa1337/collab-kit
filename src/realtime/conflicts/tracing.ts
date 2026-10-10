import type { Db, Document, ObjectId } from 'mongodb';
import type { Logger } from 'pino';

import type { Anchor } from '../../model/anchor.ts';
import { recordEvent, type NewEvent } from '../../db/collections/events.ts';
import { creatorsOf } from '../../db/collections/updates.ts';
import { eventKeysOf, withNames } from '../../db/names.ts';
import { encodeEvent } from '../connection/protocol.ts';
import { deleterOf } from '../hub/persistence.ts';
import { idKey, type Loss, type Removal } from './deletions.ts';
import { lossEvents, removalEvents } from './events.ts';

/** Whoever may hear of an event as it happens: whether they asked, and how to reach them. */
interface Listener {
  readonly wantsEvents: boolean;
  send(message: Uint8Array): void;
}

/** What tracing needs of a workpiece: its id, who to tell, and whose pieces each client brought. */
export interface TraceTarget {
  readonly workpiece: {
    readonly workpieceId: ObjectId;
    readonly connections: Iterable<Listener>;
  };
  readonly authors: Map<number, string>;
}

/** What the hub and a merge may ask of tracing. */
export interface Tracing {
  /** Writes work-removed and work-replaced for what a change removed. */
  traceRemovals(
    loaded: TraceTarget,
    removals: readonly Removal[],
    createdBy: string,
    at: ObjectId,
    extra?: Document,
  ): Promise<void>;
  /** Writes work-lost and sends it at once to whoever asked. */
  traceLosses(
    loaded: TraceTarget,
    losses: readonly Loss[],
    sender: string,
    at: ObjectId,
    extra?: Document,
  ): Promise<void>;
}

/** Looks up whose work a change hit and writes the conflict events; one per hub. */
export function createTracing(db: Db, logger: Logger): Tracing {
  /** Whose pieces these clients brought; asked of the database once, remembered from then on. */
  async function authorsOf(
    loaded: TraceTarget,
    clients: readonly number[],
  ): Promise<ReadonlyMap<number, string>> {
    const workpieceId = loaded.workpiece.workpieceId;
    const missing = [...new Set(clients)].filter((client) => !loaded.authors.has(client));
    if (missing.length > 0) {
      for (const [client, author] of await creatorsOf(db, workpieceId, missing)) {
        loaded.authors.set(client, author);
      }
    }

    // Whose author no stored change names stays out of the events.
    const unknown = missing.filter((client) => !loaded.authors.has(client));
    if (unknown.length > 0) {
      logger.warn(
        { workpieceId: workpieceId.toHexString(), clients: unknown },
        'deleted pieces whose author no stored change names, left out',
      );
    }
    return loaded.authors;
  }

  /** Tells whose work a change removed or replaced; a failure is only logged, like any trace. */
  async function traceRemovals(
    loaded: TraceTarget,
    removals: readonly Removal[],
    createdBy: string,
    at: ObjectId,
    extra: Document = {},
  ): Promise<void> {
    const workpieceId = loaded.workpiece.workpieceId;

    try {
      const authors = await authorsOf(
        loaded,
        removals.map((removal) => removal.client),
      );
      const events = removalEvents(removals, authors, {
        createdBy,
        anchor: anchorOf(workpieceId),
        at,
      });
      await Promise.all(events.map((event) => recordEvent(db, withDetail(event, extra))));
    } catch (error) {
      logger.error(
        { err: error, workpieceId: workpieceId.toHexString() },
        'could not tell whose work was removed, the work carries on without it',
      );
    }
  }

  /** Tells who lost work to whom, at once to whoever asked; a failure is only logged. */
  async function traceLosses(
    loaded: TraceTarget,
    losses: readonly Loss[],
    sender: string,
    at: ObjectId,
    extra: Document = {},
  ): Promise<void> {
    const workpieceId = loaded.workpiece.workpieceId;

    try {
      // Whose the lost pieces are, and whose the values that took their keys.
      const authors = await authorsOf(
        loaded,
        losses.flatMap((loss) =>
          loss.cause === 'overwritten' ? [loss.client, loss.other.client] : [loss.client],
        ),
      );

      // Who deleted each place: the sender, if this change did, else whoever stored it.
      const places = new Map(
        losses
          .filter((loss) => loss.cause === 'place-removed')
          .map((loss) => [idKey(loss.other), loss]),
      );
      const deleters = new Map<string, string>();
      await Promise.all(
        [...places].map(async ([key, loss]) => {
          const deleter = loss.removedNow ? sender : await deleterOf(db, workpieceId, loss.other);
          if (deleter !== undefined) {
            deleters.set(key, deleter);
          }
        }),
      );

      const events = lossEvents(losses, authors, deleters, {
        anchor: anchorOf(workpieceId),
        at,
        sender,
      });
      await Promise.all(
        events.map(async (event) => {
          const record = await recordEvent(db, withDetail(event, extra));
          // Only what is written goes out, so nobody hears of an event that is nowhere kept.
          notify(loaded.workpiece, encodeEvent(await withNames(db, record, eventKeysOf)));
        }),
      );
    } catch (error) {
      logger.error(
        { err: error, workpieceId: workpieceId.toHexString() },
        'could not tell whose work was lost, the work carries on without it',
      );
    }
  }

  return { traceRemovals, traceLosses };
}

/** Sends a message to every connection on the workpiece that asked for events. */
function notify(workpiece: TraceTarget['workpiece'], message: Uint8Array): void {
  for (const connection of workpiece.connections) {
    if (connection.wantsEvents) {
      connection.send(message);
    }
  }
}

/** An event with more in its detail, such as the merge it came from. */
function withDetail(event: NewEvent, extra: Document): NewEvent {
  return Object.keys(extra).length === 0
    ? event
    : { ...event, detail: { ...event.detail, ...extra } };
}

/** The anchor that the events of a workpiece hang on. */
export function anchorOf(workpieceId: ObjectId): Anchor {
  return { kind: 'workpiece', id: workpieceId };
}
