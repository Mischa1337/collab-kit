/** What the client library shows, and the source of v1.d.ts: nothing of the library inside. */

// Entry: what a tool calls first, and what it gets back.

/** The entry of the library, one per instance of CK. */
export declare function createCollabKitApi(options: CollabKitOptions): CollabKitApi;

/** Where CK runs and how the tool gets a token. */
export interface CollabKitOptions {
  /** Address of CK as http or https; the socket is the same address with ws or wss and /ws. */
  readonly url: string;
  /** Asked before every connection and every call, so a renewed token counts at once. */
  getToken(): string | Promise<string>;
}

/** What the library offers for one instance of CK: sessions, and one function per route. */
export interface CollabKitApi {
  /** Opens a session at a workpiece; it connects at once and keeps its Y.Doc until close. */
  open<Value = unknown>(workpieceId: string, options?: OpenOptions): Session<Value>;
  readonly rooms: RoomRoutes;
  readonly groups: GroupRoutes;
  readonly grants: GrantRoutes;
  readonly workpieces: WorkpieceRoutes;
  readonly comments: CommentRoutes;
  readonly tasks: TaskRoutes;
  readonly events: EventRoutes;
  readonly actors: ActorRoutes;
  readonly me: MeRoutes;
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

// Session: one open workpiece with its units, texts, presence and events.

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
  /** The text of this name in the doc, the same object for the same name; throws after close. */
  text(name: string): SharedText;
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
  /** Yjs itself, unknown so v1.d.ts needs no Yjs; who uses it names the type with import type. */
  readonly yjs: { readonly doc: unknown; readonly awareness: unknown };
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
  readonly event: Named<CollabEvent>;
}

/** The units of the workpiece: one value per key of the map. */
export interface Units<Value = unknown> {
  get(key: string): Value | undefined;
  entries(): [string, Value][];
  /** Sets and deletes as one change and one step; throws without edit, as CK would with 1008. */
  update(change: UnitChange<Value>, options?: UpdateOptions): void;
  /** The keys a change touched, and whether the editor has yet to take it: remote, undo, redo. */
  onChange(listener: (keys: string[], remote: boolean) => void): () => void;
  /** Takes back the last own step, never what others set since; tells whether there was one. */
  undo(): boolean;
  /** Does again what undo took back; tells whether there was something. */
  redo(): boolean;
  /** Whether there is a step to take back; read after update, undo and redo, false after close. */
  canUndo(): boolean;
  /** Whether there is a step to do again. */
  canRedo(): boolean;
}

/** One change to the units; a value is always written whole. */
export interface UnitChange<Value = unknown> {
  readonly set?: Readonly<Record<string, Value>>;
  readonly delete?: readonly string[];
}

/** How a change goes in; undoable false keeps it out of undo, as when loading a whole state. */
export interface UpdateOptions {
  /** Left out, true. */
  readonly undoable?: boolean;
}

/** A text of the workpiece, changed and told of as change lists; the editor is up to the tool. */
export interface SharedText {
  /** The text without its formatting. */
  readonly value: string;
  /** The whole content with its attributes, to load an editor. */
  delta(): TextDelta;
  /** Applies one change; throws without edit, where CK would close with 1008. */
  update(delta: TextDelta, options?: UpdateOptions): void;
  /** Every change in the same form; own only for update of this session. */
  onChange(listener: (delta: TextDelta, own: boolean) => void): () => void;
  /** A place that moves along when others type before it, as JSON for presence. */
  cursor(index: number): TextPosition;
  /** Where a place stands now; undefined if it lies in another text or is unknown. */
  indexOf(position: TextPosition): number | undefined;
  /** Takes back the last own change, never one of others; tells whether there was one. */
  undo(): boolean;
  /** Does again what undo took back; tells whether there was something. */
  redo(): boolean;
  /** Whether there is a change to take back; read after update, undo, redo; false after close. */
  canUndo(): boolean;
  /** Whether there is a change to do again. */
  canRedo(): boolean;
}

/** A change to a text, step by step from its start; attributes are free, null removes one. */
export type TextDelta = readonly (
  | { readonly insert: string; readonly attributes?: Free }
  | { readonly retain: number; readonly attributes?: Free }
  | { readonly delete: number }
)[];

/** A place in a text as Yjs keeps it; only indexOf reads it. */
export type TextPosition = Free;

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

// Values: what the routes and the events of a session give back.

/** Free fields of the tool, which CK stores and never reads. */
export type Free = Readonly<Record<string, unknown>>;

/** Key to name for the people in an answer, as far as CK knows a name. */
export type Names = Readonly<Record<string, string>>;

/** An answer of CK with the names of the people in it, as far as any are known. */
export type Named<Value> = Value & { readonly names?: Names };

/** The six rights; who gets them where is up to the tool. */
export type Right = 'see' | 'speak' | 'edit' | 'plan' | 'decide' | 'manage';

/** A thing of CK something hangs on or points at. */
export interface Reference {
  readonly kind: string;
  readonly id: string;
}

/** A thing, or with unit one place inside it. */
export interface Anchor extends Reference {
  readonly unit?: string;
}

/** Whom a token names, as GET /me gives it. */
export interface Me {
  readonly actorId: string;
  readonly label?: string;
}

/** An event as the routes give it; kind and detail are free where the tool writes them. */
export interface CollabEvent {
  readonly _id: string;
  readonly kind: string;
  readonly createdBy: string;
  readonly anchor: Anchor;
  readonly about?: Reference;
  readonly at?: string;
  readonly affects?: readonly string[];
  readonly label?: string;
  readonly reason?: string;
  readonly detail?: Free;
  readonly createdAt: string;
}

/** A room: the workpieces it bundles, its settings; who may in stands in the grants. */
export interface Room {
  readonly _id: string;
  readonly name: string;
  readonly settings: Free;
  readonly workpieces: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
}

/** A group of people, by their keys. */
export interface Group {
  readonly _id: string;
  readonly name: string;
  readonly settings: Free;
  readonly members: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
}

/** What one group may do at one place, or everywhere without one. */
export interface Grant {
  readonly _id: string;
  readonly groupId: string;
  readonly scope?: Reference;
  readonly rights: readonly Right[];
  readonly createdAt: string;
  readonly createdBy: string;
}

/** One map holding units, by its path from the top of the doc. */
export interface UnitContainer {
  readonly path: readonly string[];
}

/** The workpiece as a thing; its content is the doc of a session. */
export interface Workpiece {
  readonly _id: string;
  readonly name: string;
  readonly contract: Free;
  readonly units: readonly UnitContainer[];
  /** Only at a fork: where and up to which change it was forked. */
  readonly forkOf?: { readonly id: string; readonly at?: string };
  readonly createdAt: string;
  readonly createdBy: string;
}

/** One stored change: who and when, the bytes only as a size. */
export interface UpdateSummary {
  readonly _id: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly bytes: number;
}

/** The stored state as Yjs bytes, and the change it reaches. */
export interface State {
  readonly state: Uint8Array;
  readonly upToUpdateId?: string;
}

/** The newest trace of one person. */
export interface Activity {
  readonly actorId: string;
  readonly at: string;
  readonly kind: string;
}

/** A person connected to a workpiece of the room, and over how many connections, such as tabs. */
export interface RoomPresence {
  readonly workpieceId: string;
  readonly actorId: string;
  readonly connections: number;
}

/** A comment; deleted, its body is empty and the shell stays for the answers. */
export interface CollabComment {
  readonly _id: string;
  readonly kind: string;
  readonly anchor: Anchor;
  readonly parentId?: string;
  readonly createdBy: string;
  readonly body: Free;
  readonly state?: string;
  readonly createdAt: string;
  readonly editedAt?: string;
  readonly deletedAt?: string;
  readonly deletedBy?: string;
}

/** A person by actor key or a group by its key. */
export interface Assignee {
  readonly kind: 'actor' | 'group';
  readonly id: string;
}

/** Something to be done, with a state the tool names. */
export interface Task {
  readonly _id: string;
  readonly kind: string;
  readonly title: string;
  readonly state: string;
  readonly anchor?: Anchor;
  readonly parentId?: string;
  readonly assignees: readonly Assignee[];
  readonly order?: number;
  readonly detail?: Free;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** The stored name of a person, if there is one. */
export interface ActorName {
  readonly actorId: string;
  readonly label?: string;
}

// Routes: shared inputs first, then each group with its inputs before its functions.

/** Why something is removed; it goes into the event. */
export interface Reasoned {
  readonly reason?: string;
}

/** A new name, new settings or both, for a room or a group; only the name leaves a trace. */
export interface PlaceChange {
  readonly name?: string;
  readonly settings?: Free;
  readonly reason?: string;
}

/** Where to look: the thing and all in it, one unit, or with scope whole the thing alone. */
export interface AnchorQuery {
  readonly anchorKind: string;
  readonly anchorId: string;
  readonly unit?: string;
  readonly scope?: 'whole';
}

/** A new room; creating one takes manage everywhere. */
export interface NewRoom {
  readonly name: string;
  readonly settings?: Free;
}

/** Events of a room and all it bundles, oldest first after since. */
export interface RoomEventQuery {
  readonly since?: string;
  readonly kind?: string;
  readonly createdBy?: string;
  readonly limit?: number;
}

/** The routes under /rooms, and the stream of a room. */
export interface RoomRoutes {
  create(room: NewRoom): Promise<Named<Room>>;
  get(id: string): Promise<Named<Room>>;
  update(id: string, change: PlaceChange): Promise<Named<Room>>;
  remove(id: string, options?: Reasoned): Promise<{ readonly deleted: boolean }>;
  addWorkpiece(id: string, workpieceId: string): Promise<Named<Room>>;
  removeWorkpiece(id: string, workpieceId: string): Promise<Named<Room>>;
  events(id: string, query?: RoomEventQuery): Promise<Named<CollabEvent>[]>;
  activity(id: string): Promise<Named<Activity>[]>;
  /** Who is connected to which of its workpieces right now; asked for, never told. */
  presence(id: string): Promise<Named<RoomPresence>[]>;
}

/** A new group; creating one takes manage everywhere. */
export interface NewGroup {
  readonly name: string;
  readonly members?: readonly string[];
  readonly settings?: Free;
}

/** The routes under /groups. */
export interface GroupRoutes {
  create(group: NewGroup): Promise<Named<Group>>;
  list(): Promise<Named<Group>[]>;
  get(id: string): Promise<Named<Group>>;
  update(id: string, change: PlaceChange): Promise<Named<Group>>;
  remove(id: string, options?: Reasoned): Promise<{ readonly deleted: boolean }>;
  addMember(id: string, actorId: string): Promise<Named<Group>>;
  removeMember(id: string, actorId: string): Promise<Named<Group>>;
}

/** What a group may do at a place, replacing what it had there. */
export interface GrantChange {
  readonly groupId: string;
  readonly scope?: Reference;
  readonly rights: readonly Right[];
  readonly reason?: string;
}

/** Which grant to take away. */
export interface GrantRemoval {
  readonly groupId: string;
  readonly scope?: Reference;
  readonly reason?: string;
}

/** The grants of a group, or at a place, or everywhere without either. */
export interface GrantQuery {
  readonly groupId?: string;
  readonly scope?: Reference;
}

/** The routes under /grants. */
export interface GrantRoutes {
  set(grant: GrantChange): Promise<Named<Grant>>;
  remove(grant: GrantRemoval): Promise<{ readonly removed: boolean }>;
  list(query?: GrantQuery): Promise<Named<Grant>[]>;
}

/** A new workpiece, in a room or outside every room. */
export interface NewWorkpiece {
  readonly name: string;
  readonly contract?: Free;
  readonly roomId?: string;
  readonly units?: readonly UnitContainer[];
}

/** Changes after since, at most limit. */
export interface UpdateQuery {
  readonly since?: string;
  readonly limit?: number;
}

/** A named moment of the work. */
export interface NewCheckpoint {
  readonly label?: string;
  readonly reason?: string;
}

/** A fork up to the change at, or of all there is. */
export interface NewFork {
  readonly name: string;
  readonly at?: string;
  readonly roomId?: string;
  readonly reason?: string;
}

/** Where the changes to merge come from. */
export interface NewMerge {
  readonly from: string;
  readonly reason?: string;
}

/** The routes under /workpieces; the content itself goes through a session. */
export interface WorkpieceRoutes {
  create(workpiece: NewWorkpiece): Promise<Named<Workpiece>>;
  list(): Promise<Named<Workpiece>[]>;
  get(id: string): Promise<Named<Workpiece>>;
  updates(id: string, query?: UpdateQuery): Promise<Named<UpdateSummary>[]>;
  activity(id: string): Promise<Named<Activity>[]>;
  /** The state after the change at, or the newest. */
  state(id: string, at?: string): Promise<State>;
  checkpoint(id: string, checkpoint?: NewCheckpoint): Promise<Named<CollabEvent>>;
  fork(id: string, fork: NewFork): Promise<Named<Workpiece>>;
  merge(id: string, merge: NewMerge): Promise<Named<CollabEvent>>;
}

/** A comment on a thing, or an answer to another comment on the same thing. */
export interface NewComment {
  readonly kind: string;
  readonly anchor: Anchor;
  readonly body: Free;
  readonly parentId?: string;
  readonly state?: string;
}

/** Comments at an anchor; parentId none for those that answer nothing. */
export interface CommentQuery extends AnchorQuery {
  readonly parentId?: string;
  readonly kind?: string;
  readonly state?: string;
  readonly createdBy?: string;
  readonly since?: string;
}

/** New words, a new state or both. */
export interface CommentChange {
  readonly body?: Free;
  readonly state?: string;
  readonly reason?: string;
}

/** The routes under /comments. */
export interface CommentRoutes {
  create(comment: NewComment): Promise<Named<CollabComment>>;
  get(id: string): Promise<Named<CollabComment>>;
  list(query: CommentQuery): Promise<Named<CollabComment>[]>;
  update(id: string, change: CommentChange): Promise<Named<CollabComment>>;
  remove(id: string, options?: Reasoned): Promise<Named<CollabComment>>;
}

/** A new task, at a thing, under another task, or at nothing. */
export interface NewTask {
  readonly kind: string;
  readonly title: string;
  readonly state: string;
  readonly anchor?: Anchor;
  readonly parentId?: string;
  readonly assignees?: readonly Assignee[];
  readonly order?: number;
  readonly detail?: Free;
}

/** Tasks at an anchor or under a parent, one of them needed. */
export interface TaskQuery {
  readonly anchorKind?: string;
  readonly anchorId?: string;
  readonly unit?: string;
  readonly scope?: 'whole';
  readonly parentId?: string;
  readonly assigneeKind?: 'actor' | 'group';
  readonly assigneeId?: string;
  readonly kind?: string;
  readonly state?: string;
}

/** A new state of a task. */
export interface TaskChange {
  readonly state: string;
  readonly reason?: string;
}

/** The routes under /tasks. */
export interface TaskRoutes {
  create(task: NewTask): Promise<Named<Task>>;
  get(id: string): Promise<Named<Task>>;
  list(query: TaskQuery): Promise<Named<Task>[]>;
  update(id: string, change: TaskChange): Promise<Named<Task>>;
  addAssignee(id: string, assignee: Assignee, options?: Reasoned): Promise<Named<Task>>;
  removeAssignee(id: string, assignee: Assignee, options?: Reasoned): Promise<Named<Task>>;
}

/** What the tool reports itself, such as a visit; kinds of CK are refused. */
export interface NewEvent {
  readonly kind: string;
  readonly anchor: Anchor;
  readonly at?: string;
  readonly label?: string;
  readonly reason?: string;
  readonly detail?: Free;
}

/** Events at an anchor: forwards after since, else newest first. */
export interface EventQuery extends AnchorQuery {
  readonly since?: string;
  readonly before?: string;
  readonly kind?: string;
  readonly createdBy?: string;
  readonly limit?: number;
}

/** The routes under /events, and the events of all rooms at once. */
export interface EventRoutes {
  create(event: NewEvent): Promise<Named<CollabEvent>>;
  list(query: EventQuery): Promise<Named<CollabEvent>[]>;
  /** No route: every room of /me/rooms asked, each event once, oldest first, limit for all. */
  inRooms(query?: RoomEventQuery): Promise<Named<CollabEvent>[]>;
}

/** The route under /actors. */
export interface ActorRoutes {
  /** The stored names of these people, as far as the token may put a name to them. */
  names(actorIds: readonly string[]): Promise<ActorName[]>;
}

/** Tasks given to the own person or one of its groups. */
export interface MyTaskQuery {
  readonly state?: string;
}

/** Events concerning the own person, wherever it still sees. */
export interface MyEventQuery {
  readonly since?: string;
  readonly before?: string;
  readonly kind?: string;
  readonly limit?: number;
}

/** The routes under /me: what concerns the token itself. */
export interface MeRoutes {
  who(): Promise<Me>;
  /** The rights at a thing, or everywhere without one. */
  rights(target?: Reference): Promise<Right[]>;
  rooms(): Promise<Named<Room>[]>;
  groups(): Promise<Named<Group>[]>;
  tasks(query?: MyTaskQuery): Promise<Named<Task>[]>;
  events(query?: MyEventQuery): Promise<Named<CollabEvent>[]>;
}
