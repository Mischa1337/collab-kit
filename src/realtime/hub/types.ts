import type { Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import type * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';

import type { Actor } from '../../model/actor.ts';
import type { ActorNotes } from '../../db/collections/actors.ts';
import type { EventRecord } from '../../db/collections/events.ts';
import type { UpdateRecord } from '../../db/collections/updates.ts';

/** What the hub needs from a connection, so it does not depend on the transport. */
export interface Connection {
  readonly actor: Actor;
  /** Whether it asked with ?events=1 to hear of events as they happen, as message 101. */
  readonly wantsEvents: boolean;
  send(message: Uint8Array): void;
  /** Ends the connection; a client that comes back syncs again from the stored state. */
  close(code: number, reason: string): void;
}

/** A workpiece while somebody holds it: its Y.Doc, who is present and who is connected. */
export interface OpenWorkpiece {
  readonly workpieceId: ObjectId;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly connections: Set<Connection>;
  /** Whether a connection may speak for an awareness client: never for another person's. */
  mayAnnounce(connection: Connection, clientId: number): boolean;
}

/** What a person gives a checkpoint: who sets it, a name and the why. */
export interface NewCheckpoint {
  readonly createdBy: string;
  readonly label?: string;
  readonly reason?: string;
}

/** What a merge replays: the changes of another workpiece after the mark, and on whose behalf. */
export interface Merge {
  /** The workpiece the changes come from. */
  readonly from: ObjectId;
  /** Its changes after the mark, oldest first, each still under its author. */
  readonly rows: readonly UpdateRecord[];
  /** The last change of from the target holds afterwards, the mark for the next merge. */
  readonly upTo?: ObjectId;
  readonly createdBy: string;
  readonly reason?: string;
}

/** What the gateway and the routes may ask of the hub. */
export interface WorkpieceHub {
  /** Adds a connection, loading the workpiece if it is the first. */
  join(workpieceId: ObjectId, connection: Connection): Promise<OpenWorkpiece>;
  /** Removes a connection and leaves a trace; the last one out closes the workpiece. */
  leave(workpieceId: ObjectId, connection: Connection): Promise<void>;
  /** Marks this state as worth coming back to; reason is the only place for the why. */
  checkpoint(workpieceId: ObjectId, input: NewCheckpoint): Promise<EventRecord>;
  /** The newest stored change, after whatever is on its way; undefined while there is none. */
  storedUpTo(workpieceId: ObjectId): Promise<ObjectId | undefined>;
  /** Replays the changes of another workpiece as their authors' and writes workpiece-merged. */
  merge(workpieceId: ObjectId, input: Merge): Promise<EventRecord>;
  /** How many connections hold this workpiece right now. */
  count(workpieceId: ObjectId): number;
  /** Lets go of every workpiece, for the shutdown. */
  close(): Promise<void>;
}

/** What a hub is made with: where it stores and logs, how often it folds, who notes names. */
export interface HubOptions {
  readonly db: Db;
  readonly logger: Logger;
  /** Changes that may pile up before folding again; only a matter of loading time. */
  readonly foldEvery?: number;
  /** Shared with the routes, so a name is written once; left out, the hub keeps its own. */
  readonly noteActor?: ActorNotes;
}
