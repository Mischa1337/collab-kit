/** What the client library shows, and the source of v1.d.ts: nothing of the library inside. */

import type { Awareness } from 'y-protocols/awareness';
import type { Doc } from 'yjs';

/** Where CK runs and how the tool gets a token. */
export interface CollabKitOptions {
  /** Address of CK as http or https; the socket is the same address with ws or wss and /ws. */
  readonly url: string;
  /** Asked before every connection and every call, so a renewed token counts at once. */
  getToken(): string | Promise<string>;
}

/** What the library offers for one instance of CK. */
export interface CollabKitApi {
  /** Opens a session at a workpiece; it connects at once and keeps its Y.Doc until close. */
  open<Value = unknown>(workpieceId: string, options?: OpenOptions): Session<Value>;
}

/** How a session reads the workpiece. */
export interface OpenOptions {
  /** The top Y.Map holding one value per unit; left out, units. */
  readonly map?: string;
}

/** Where the connection stands; closed lasts until connect is called. */
export type Status = 'connecting' | 'connected' | 'disconnected' | 'closed';

/** One open workpiece: its units, who else is there, and what CK reports. */
export interface Session<Value = unknown> {
  readonly workpieceId: string;
  /** Fulfilled once the state of CK is in; rejected if the session ends before. */
  readonly synced: Promise<void>;
  /** The Yjs client of this session, the same over every reconnect. */
  readonly clientId: number;
  /** Whether this person may change the workpiece, as CK said before the last connection. */
  readonly mayWrite: boolean;
  readonly status: Status;
  readonly units: Units<Value>;
  readonly presence: Presence;
  /** Calls the listener on every such event; gives back how to stop. */
  on<Kind extends keyof SessionEvents>(
    kind: Kind,
    listener: (value: SessionEvents[Kind]) => void,
  ): () => void;
  /** Lets go of the connection, keeps the doc; what changes meanwhile goes out on connect. */
  disconnect(): void;
  /** Connects again after disconnect or closed. */
  connect(): void;
  /** Yjs itself, for what units and presence do not cover; never a second Yjs beside it. */
  readonly yjs: { readonly doc: Doc; readonly awareness: Awareness };
  /** Ends the session for good and lets go of the doc. */
  close(): void;
}

/** The value each event of a session brings. */
export interface SessionEvents {
  readonly status: Status;
  /** May write now or not, when CK answers otherwise than before. */
  readonly rightsChanged: boolean;
  /** CK ended the session; it stays closed until connect is called. */
  readonly closed: Closed;
  /** A change lost at this workpiece, to whoever was involved and whoever was not. */
  readonly conflict: Conflict;
}

/** Why a session ended: the close code, or 4000 plus the status of a call before connecting. */
export interface Closed {
  readonly code: number;
  readonly reason: string;
}

/** The units of the workpiece: one value per key of the map. */
export interface Units<Value = unknown> {
  get(key: string): Value | undefined;
  entries(): [string, Value][];
  /** Sets and deletes in one change; throws without edit, where CK would close with 1008. */
  update(change: UnitChange<Value>): void;
  /** The keys a change touched, and whether it came from elsewhere. */
  onChange(listener: (keys: string[], remote: boolean) => void): () => void;
}

/** One change to the units; a value is always written whole. */
export interface UnitChange<Value = unknown> {
  readonly set?: Readonly<Record<string, Value>>;
  readonly delete?: readonly string[];
}

/** Who is at the workpiece; what an entry holds besides person is up to the tool. */
export interface Presence {
  /** Adds or replaces these fields of the own entry; person stays the library's. */
  set(fields: Readonly<Record<string, unknown>>): void;
  /** One per person, however many sessions they have open. */
  people(): Person[];
  onChange(listener: () => void): () => void;
}

/** A person at the workpiece, as their sessions announce them; a hint, not a proof. */
export interface Person {
  readonly id: string;
  readonly name?: string;
  /** Whether it is the own person, in this session or another one. */
  readonly self: boolean;
  /** Every session of this person with its entry. */
  readonly clients: readonly PresenceClient[];
}

/** One session of a person and what it announces. */
export interface PresenceClient {
  readonly clientId: number;
  readonly state: Readonly<Record<string, unknown>>;
}

/** A change lost because two changed the same place without knowing of each other. */
export interface Conflict {
  /** The key of the unit, if the workpiece names the map as holding units. */
  readonly unit?: string;
  readonly cause: 'overwritten' | 'place-removed';
  /** Whose change was lost. */
  readonly loser: string;
  /** Whose value stands, or who removed the place. */
  readonly winner: string;
  /** Whether the own person lost. */
  readonly mine: boolean;
  readonly names: Names;
  /** The work-lost event as the routes give it. */
  readonly event: CollabEvent;
}

/** Key to name for the people in an answer, as far as CK knows a name. */
export type Names = Readonly<Record<string, string>>;

/** Whom a token names, as GET /me gives it. */
export interface Me {
  readonly actorId: string;
  readonly label?: string;
}

/** A thing of CK something hangs on. */
export interface Reference {
  readonly kind: string;
  readonly id: string;
}

/** An event as the routes give it; kind and detail are free where the tool writes them. */
export interface CollabEvent {
  readonly _id: string;
  readonly kind: string;
  readonly createdBy: string;
  readonly anchor: Reference & { readonly unit?: string };
  readonly about?: Reference;
  readonly at?: string;
  readonly affects?: readonly string[];
  readonly label?: string;
  readonly reason?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly names?: Names;
}

/** A refusal of CK, or of the library in its place: a status and what CK said. */
export class CollabKitError extends Error {
  /** The HTTP status of a call, or the close code that ended a session. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CollabKitError';
    this.status = status;
  }
}

/** The entry of the library, one per instance of CK. */
export declare function createCollabKitApi(options: CollabKitOptions): CollabKitApi;
