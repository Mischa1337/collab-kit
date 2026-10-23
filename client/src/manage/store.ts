/** The data of <ck-management> and every call to CK; the element only draws what it holds. */

import type { ReactiveControllerHost } from 'lit';

import type {
  ActorName,
  Grant,
  Group,
  ManagementOptions,
  Named,
  Reference,
  Right,
  Room,
  Workpiece,
} from '../api.ts';
import type { Texts } from './look/texts.ts';

/** The six rights in the order CK names them. */
export const RIGHTS: readonly Right[] = ['see', 'speak', 'edit', 'plan', 'decide', 'manage'];

/** What one chip of a grant switches: a right, or whether its members write anonymously. */
export type Switch = Right | 'anonymous';

/** Which list is shown. */
export type Tab = 'rooms' | 'groups';

/** What the one open form is for. */
export type FormKind = 'room' | 'group' | 'workpiece' | 'member' | 'rename' | 'remove';

/** The one form open at a time, with what went wrong or whom findPeople found. */
export interface Form {
  readonly kind: FormKind;
  readonly error?: string;
  readonly found?: readonly ActorName[];
}

/** The own rights at the shown room or group, and its grants where the person may read them. */
export interface Detail {
  readonly place: Reference;
  readonly rights: readonly Right[];
  readonly grants?: readonly Named<Grant>[];
}

/** Everything the element shows. */
export interface State {
  readonly tab: Tab;
  readonly rooms: readonly Named<Room>[];
  readonly groups: readonly Named<Group>[];
  readonly workpieces: ReadonlyMap<string, Workpiece>;
  /** Names to the keys of people, as CK or findPeople gave them. */
  readonly names: Readonly<Record<string, string>>;
  /** Whether the person holds manage everywhere, which creating a room or a group takes. */
  readonly mayCreate: boolean;
  readonly selected: Readonly<Record<Tab, string | undefined>>;
  readonly detail: Detail | undefined;
  readonly form: Form | undefined;
  readonly busy: boolean;
  /** What CK refused last, when no form was open to show it. */
  readonly failure: string | undefined;
  readonly loaded: boolean;
}

/** Before ck is set. */
const EMPTY: State = {
  tab: 'rooms',
  rooms: [],
  groups: [],
  workpieces: new Map(),
  names: {},
  mayCreate: false,
  selected: { rooms: undefined, groups: undefined },
  detail: undefined,
  form: undefined,
  busy: false,
  failure: undefined,
  loaded: false,
};

/** The rights after switching one, in the order of RIGHTS. */
export function switched(rights: readonly Right[], right: Right): Right[] {
  return RIGHTS.filter((each) => (each === right) !== rights.includes(each));
}

/** By name, as people look for them. */
function byName<Item extends { readonly name: string }>(items: readonly Item[]): Item[] {
  return items.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The status CK refused with, if it was a refusal of CK. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { readonly status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Holds the state, asks CK with the ck of the element, and has it drawn again on each change. */
export class Store {
  /** Replaced as a whole on every change, never changed in place. */
  state: State = EMPTY;

  private readonly host: ReactiveControllerHost & ManagementOptions;
  private readonly words: () => Texts;
  /** Calls under way; busy while there is any. */
  private pending = 0;

  constructor(host: ReactiveControllerHost & ManagementOptions, words: () => Texts) {
    this.host = host;
    this.words = words;
  }

  /** Everything the person sees, asked for anew; the selection stays where it still exists. */
  async load(): Promise<void> {
    const ck = this.host.ck;
    this.set({ loaded: false, detail: undefined });
    if (ck === undefined) {
      return;
    }

    await this.run(async () => {
      const [everywhere, rooms, groups, workpieces] = await Promise.all([
        ck.me.rights(),
        ck.me.rooms(),
        ck.groups.list(),
        ck.workpieces.list(),
      ]);
      // Another ck came meanwhile and loads its own.
      if (ck !== this.host.ck) {
        return;
      }
      this.set({
        mayCreate: everywhere.includes('manage'),
        rooms: byName(rooms),
        groups: byName(groups),
        workpieces: new Map(workpieces.map((workpiece) => [workpiece._id, workpiece])),
        loaded: true,
      });
      this.takeNames(...groups);
      await this.select(this.keptOrFirst(this.state.tab));
    });
  }

  async show(tab: Tab): Promise<void> {
    this.set({ tab, form: undefined, failure: undefined });
    await this.select(this.keptOrFirst(tab));
  }

  /** Shows this room or group of the tab, with the rights and grants there. */
  async select(id: string | undefined): Promise<void> {
    this.set({ selected: { ...this.state.selected, [this.state.tab]: id }, form: undefined });
    await this.loadDetail();
  }

  room(): Named<Room> | undefined {
    return this.state.rooms.find((room) => room._id === this.state.selected.rooms);
  }

  group(): Named<Group> | undefined {
    return this.state.groups.find((group) => group._id === this.state.selected.groups);
  }

  /** The detail of this room or group, if it is the one loaded. */
  detailOf(id: string): Detail | undefined {
    return this.state.detail?.place.id === id ? this.state.detail : undefined;
  }

  /** Where a grant of a group holds, by name where the person knows the place. */
  placeName(scope: Reference | undefined): string {
    if (scope === undefined) {
      return this.words().everywhere;
    }
    const { rooms, groups, workpieces } = this.state;
    const known =
      scope.kind === 'room'
        ? rooms.find((room) => room._id === scope.id)
        : scope.kind === 'group'
          ? groups.find((group) => group._id === scope.id)
          : scope.kind === 'workpiece'
            ? workpieces.get(scope.id)
            : undefined;
    return known?.name ?? `${scope.kind} ${scope.id}`;
  }

  /** Opens this form, or closes it when it is already open. */
  openForm(kind: FormKind): void {
    this.set({ form: this.state.form?.kind === kind ? undefined : { kind } });
  }

  closeForm(): void {
    this.set({ form: undefined });
  }

  /** Typing again takes away what went wrong and whom findPeople found. */
  clearError(): void {
    const { form } = this.state;
    if (form !== undefined && (form.error !== undefined || form.found !== undefined)) {
      this.set({ form: { kind: form.kind } });
    }
  }

  /** The text of a form, checked here, then carried out by CK. */
  async submit(kind: FormKind, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '') {
      const t = this.words();
      this.set({ form: { kind, error: kind === 'member' ? t.keyMissing : t.nameMissing } });
      return;
    }
    await this.run(() => this.carryOut(kind, trimmed));
  }

  async takeOut(room: Room, workpieceId: string): Promise<void> {
    await this.run(async () => {
      this.replaceRoom(await this.ck().rooms.removeWorkpiece(room._id, workpieceId));
    });
  }

  /** A group gets access to the room, at first only to see it. */
  async give(room: Room, groupId: string): Promise<void> {
    await this.run(async () => {
      const grant = await this.ck().grants.set({
        groupId,
        scope: { kind: 'room', id: room._id },
        rights: ['see'],
      });
      this.takeNames(grant);
      this.changeGrants((grants) => [...grants, grant]);
    });
  }

  /** Switches one right of a grant or its flag; without any right left the grant goes. */
  async toggle(grant: Grant, chip: Switch): Promise<void> {
    const rights = chip === 'anonymous' ? [...grant.rights] : switched(grant.rights, chip);
    // Set whole, so the flag goes along with every right switched, and stays as it was.
    const anonymous = (grant.anonymous === true) !== (chip === 'anonymous');
    const which =
      grant.scope === undefined
        ? { groupId: grant.groupId }
        : { groupId: grant.groupId, scope: grant.scope };

    await this.run(async () => {
      if (rights.length === 0) {
        await this.ck().grants.remove(which);
        this.changeGrants((grants) => grants.filter((each) => each._id !== grant._id));
        return;
      }
      const changed = await this.ck().grants.set({ ...which, rights, anonymous });
      this.takeNames(changed);
      this.changeGrants((grants) =>
        grants.map((each) => (each._id === grant._id ? changed : each)),
      );
    });
  }

  /** One of the people findPeople gave becomes a member. */
  async pick(group: Group, person: ActorName): Promise<void> {
    await this.run(() => this.addMember(group, person));
  }

  async dismiss(group: Group, actorId: string): Promise<void> {
    await this.run(async () => {
      this.replaceGroup(await this.ck().groups.removeMember(group._id, actorId));
    });
  }

  /** Deletes the shown room or group, once asked again, and shows the next one. */
  async removePlace(): Promise<void> {
    const place = this.place();
    if (place === undefined) {
      return;
    }

    await this.run(async () => {
      if (place.kind === 'room') {
        await this.ck().rooms.remove(place.id);
        this.set({ rooms: this.state.rooms.filter((room) => room._id !== place.id) });
      } else {
        await this.ck().groups.remove(place.id);
        this.set({ groups: this.state.groups.filter((group) => group._id !== place.id) });
      }
      this.set({ form: undefined });
      await this.select(this.keptOrFirst(this.state.tab));
    });
  }

  /** What a form asks for; each change takes over the answer of CK. */
  private async carryOut(kind: FormKind, text: string): Promise<void> {
    const ck = this.ck();

    switch (kind) {
      case 'room': {
        const room = await ck.rooms.create({ name: text });
        this.set({ rooms: byName([...this.state.rooms, room]), form: undefined });
        await this.select(room._id);
        return;
      }
      case 'group': {
        const group = await ck.groups.create({ name: text });
        this.takeNames(group);
        this.set({ groups: byName([...this.state.groups, group]), form: undefined });
        await this.select(group._id);
        return;
      }
      case 'rename': {
        const place = this.place();
        if (place?.kind === 'room') {
          this.replaceRoom(await ck.rooms.update(place.id, { name: text }));
        } else if (place?.kind === 'group') {
          this.replaceGroup(await ck.groups.update(place.id, { name: text }));
        }
        this.set({ form: undefined });
        return;
      }
      case 'workpiece': {
        const room = this.room();
        const make = this.host.newWorkpiece;
        if (room === undefined || make === undefined) {
          return;
        }
        // The tool builds it, the room is the one it was created in.
        const made = await make(room, text);
        const workpiece = await ck.workpieces.create({ ...made, roomId: room._id });
        this.set({
          workpieces: new Map(this.state.workpieces).set(workpiece._id, workpiece),
          form: undefined,
        });
        this.replaceRoom(await ck.rooms.get(room._id));
        return;
      }
      case 'member': {
        const group = this.group();
        if (group === undefined) {
          return;
        }
        const find = this.host.findPeople;
        if (find === undefined) {
          await this.addMember(group, { actorId: text });
          return;
        }
        // One found is taken at once, several are offered to pick from.
        const found = await find(text);
        const [only] = found;
        if (found.length === 1 && only !== undefined) {
          await this.addMember(group, only);
        } else {
          const error = this.words().nobodyFound;
          this.set({ form: found.length === 0 ? { kind, error } : { kind, found } });
        }
        return;
      }
      case 'remove':
        return;
    }
  }

  /** The own rights at the shown place, and its grants if manage there lets them be read. */
  private async loadDetail(): Promise<void> {
    const ck = this.host.ck;
    const place = this.place();
    this.set({ detail: undefined });
    if (ck === undefined || place === undefined) {
      return;
    }

    await this.run(async () => {
      const rights = await ck.me.rights(place);
      const grants = rights.includes('manage')
        ? await ck.grants.list(place.kind === 'group' ? { groupId: place.id } : { scope: place })
        : undefined;
      // Another room or group may have been picked meanwhile.
      if (this.place()?.id !== place.id) {
        return;
      }
      if (grants === undefined) {
        this.set({ detail: { place, rights } });
        return;
      }
      this.takeNames(...grants);
      this.set({ detail: { place, rights, grants } });
    });
  }

  /** Adds a member; a name from findPeople stands in until CK knows one itself. */
  private async addMember(group: Group, person: ActorName): Promise<void> {
    const changed = await this.ck().groups.addMember(group._id, person.actorId);
    if (person.label !== undefined) {
      this.set({ names: { [person.actorId]: person.label, ...this.state.names } });
    }
    this.replaceGroup(changed);
    this.set({ form: undefined });
  }

  private place(): Reference | undefined {
    const { tab, selected } = this.state;
    const id = selected[tab];
    return id === undefined ? undefined : { kind: tab === 'rooms' ? 'room' : 'group', id };
  }

  private keptOrFirst(tab: Tab): string | undefined {
    const items: readonly { readonly _id: string }[] =
      tab === 'rooms' ? this.state.rooms : this.state.groups;
    const kept = this.state.selected[tab];
    return items.some((item) => item._id === kept) ? kept : items[0]?._id;
  }

  private changeGrants(change: (grants: readonly Named<Grant>[]) => readonly Named<Grant>[]): void {
    const { detail } = this.state;
    if (detail?.grants !== undefined) {
      this.set({ detail: { ...detail, grants: change(detail.grants) } });
    }
  }

  private replaceRoom(room: Named<Room>): void {
    const rooms = this.state.rooms.map((each) => (each._id === room._id ? room : each));
    this.set({ rooms: byName(rooms) });
  }

  private replaceGroup(group: Named<Group>): void {
    this.takeNames(group);
    const groups = this.state.groups.map((each) => (each._id === group._id ? group : each));
    this.set({ groups: byName(groups) });
  }

  /** Keeps the names CK put into its answers. */
  private takeNames(...answers: readonly Named<object>[]): void {
    const names = { ...this.state.names };
    for (const answer of answers) {
      Object.assign(names, answer.names);
    }
    this.set({ names });
  }

  /** The ck of the element; actions come only from what it drew, so only once there is one. */
  private ck(): NonNullable<ManagementOptions['ck']> {
    const { ck } = this.host;
    if (ck === undefined) {
      throw new Error('ck is not set');
    }
    return ck;
  }

  /** Takes over a change and has the element drawn again. */
  private set(change: Partial<State>): void {
    this.state = { ...this.state, ...change };
    this.host.requestUpdate();
  }

  /** Runs calls to CK; a refusal shows in the open form, else above the lists. */
  private async run(action: () => Promise<void>): Promise<void> {
    this.pending += 1;
    this.set({ busy: true, failure: undefined });
    try {
      await action();
    } catch (error) {
      const message = this.messageOf(error);
      const { form } = this.state;
      this.set(
        form === undefined ? { failure: message } : { form: { kind: form.kind, error: message } },
      );
    } finally {
      this.pending -= 1;
      this.set({ busy: this.pending > 0 });
    }
  }

  /** What went wrong in words of the element where it has some, else as CK said it. */
  private messageOf(error: unknown): string {
    const t = this.words();
    const status = statusOf(error);
    if (status === 401) {
      return t.signedOut;
    }
    if (status === 403) {
      return t.notAllowed;
    }
    if (status === 404) {
      return t.notFound;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
