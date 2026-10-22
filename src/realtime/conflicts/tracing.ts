import type { Db, Document, ObjectId } from 'mongodb';
import type { Logger } from 'pino';

import type { Anchor } from '../../model/anchor.ts';
import { recordEvent, type EventRecord, type NewEvent } from '../../db/collections/events.ts';
import type { Author } from '../../db/collections/pseudonyms.ts';
import { creatorsOf } from '../../db/collections/updates.ts';
import { EVENTS_AT_ANCHOR, withNames } from '../../db/names.ts';
import { encodeEvent } from '../connection/protocol.ts';
import { deleterOf } from '../hub/persistence.ts';
import { idKey, type Loss, type Removal } from './deletions.ts';
import { lossEvents, removalEvents } from './events.ts';

/** Whoever may hear of an event as it happens: who, whether they asked, how to reach them. */
interface Listener {
  readonly actor: { readonly actorId: string };
  /** Whether they manage the workpiece and so see the true keys behind its pseudonyms. */
  readonly seesThrough?: boolean;
  readonly wantsEvents: boolean;
  send(message: Uint8Array): void;
}

/** What tracing needs of a workpiece: its id, who to tell, and whose pieces each client brought. */
export interface TraceTarget {
  readonly workpiece: {
    readonly workpieceId: ObjectId;
    readonly connections: Iterable<Listener>;
  };
  readonly authors: Map<number, Author>;
}

/** What the hub and a merge may ask of tracing. */
export interface Tracing {
  /** Writes work-removed and work-replaced for what a change removed. */
  traceRemovals(
    loaded: TraceTarget,
    removals: readonly Removal[],
    createdBy: Author,
    at: ObjectId,
    extra?: Document,
  ): Promise<void>;
  /** Writes work-lost and sends it at once to whoever asked. */
  traceLosses(
    loaded: TraceTarget,
    losses: readonly Loss[],
    sender: Author,
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
  ): Promise<ReadonlyMap<number, Author>> {
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
    createdBy: Author,
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
    sender: Author,
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
      const deleters = new Map<string, Author>();
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
          await notify(db, loaded.workpiece, record);
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

/** Sends an event to every connection on the workpiece that asked, each masked as it may see it. */
async function notify(
  db: Db,
  workpiece: TraceTarget['workpiece'],
  event: EventRecord,
): Promise<void> {
  const listening = [...workpiece.connections].filter((connection) => connection.wantsEvents);

  await Promise.all(
    listening.map(async (connection) => {
      // The event lies at the workpiece, where the connection was let in as it sees it.
      const reader = {
        actorId: connection.actor.actorId,
        seesThrough: () => Promise.resolve(connection.seesThrough === true),
      };
      connection.send(encodeEvent(await withNames(db, event, reader, EVENTS_AT_ANCHOR)));
    }),
  );
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
