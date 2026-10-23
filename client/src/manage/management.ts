/** <ck-management>: the element; it draws what the store holds and hands every action to it. */

import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';

import type { CollabKitApi, ManagementOpen, ManagementOptions, Room, Workpiece } from '../api.ts';
import { plus } from './look/icons.ts';
import { textsFor, type Texts } from './look/texts.ts';
import { styles } from './look/theme.ts';
import { Store, type FormKind, type Tab } from './store.ts';
import { formView, headView, type FormsView } from './views/forms.ts';
import { groupView } from './views/groups.ts';
import { roomView } from './views/rooms.ts';

/** What a tool sets, as properties and the lang attribute; the rest lives in the store. */
export class Management extends LitElement implements ManagementOptions {
  static override properties = {
    ck: { attribute: false },
    newWorkpiece: { attribute: false },
    findPeople: { attribute: false },
    language: { attribute: 'lang' },
  };

  static override styles = styles;

  declare ck: CollabKitApi | undefined;
  declare newWorkpiece: ManagementOptions['newWorkpiece'];
  declare findPeople: ManagementOptions['findPeople'];
  /** The lang attribute; left out, the one of the page counts. */
  declare language: string | undefined;

  /** Data and calls to CK; it has the element drawn again on every change. */
  private readonly store = new Store(this, () => this.t);

  /** The form open at the last drawing, so a newly opened one takes the typing. */
  private shownForm: FormKind | undefined = undefined;

  /** The words in the language of the element, else of the page. */
  private get t(): Texts {
    return textsFor(this.language ?? document.documentElement.lang);
  }

  protected override willUpdate(changed: PropertyValues): void {
    // Another ck may be another person, so everything is asked for anew.
    if (changed.has('ck')) {
      void this.store.load();
    }
  }

  protected override updated(): void {
    const { busy, form } = this.store.state;
    // Tells screen readers, and whoever waits, that calls to CK are under way.
    this.toggleAttribute('aria-busy', busy);
    if (form !== undefined && form.kind !== this.shownForm) {
      this.renderRoot.querySelector<HTMLInputElement>('form input')?.focus();
    }
    this.shownForm = form?.kind;
  }

  protected override render(): TemplateResult | typeof nothing {
    if (this.ck === undefined) {
      return nothing;
    }
    const { t } = this;
    const { tab, failure } = this.store.state;

    return html`<div class="frame">
      <div class="bar" role="tablist">
        ${this.tabButton('rooms', t.rooms)} ${this.tabButton('groups', t.groups)}
      </div>
      ${failure === undefined ? nothing : html`<p class="error banner" role="alert">${failure}</p>`}
      <div class="body">
        <div class="list">${this.listView(t)}</div>
        <div class="detail">${tab === 'rooms' ? this.roomDetail(t) : this.groupDetail(t)}</div>
      </div>
    </div>`;
  }

  private tabButton(tab: Tab, label: string): TemplateResult {
    return html`<button
      class="tab"
      role="tab"
      aria-selected=${this.store.state.tab === tab}
      @click=${() => void this.store.show(tab)}
    >
      ${label}
    </button>`;
  }

  /** The rooms or the groups the person sees, and creating one with manage everywhere. */
  private listView(t: Texts): TemplateResult {
    const { tab, loaded, mayCreate, selected } = this.store.state;
    const rooms = tab === 'rooms';
    const items: readonly { readonly _id: string; readonly name: string }[] = rooms
      ? this.store.state.rooms
      : this.store.state.groups;
    const forms = this.forms(t);

    return html`
      ${
        !loaded
          ? html`<p class="empty">${t.loading}</p>`
          : items.length === 0
            ? html`<p class="empty">${rooms ? t.noRooms : t.noGroups}</p>`
            : items.map(
                (item) =>
                  html`<button
                    class="item"
                    aria-current=${item._id === selected[tab]}
                    @click=${() => void this.store.select(item._id)}
                  >
                    ${item.name}
                  </button>`,
              )
      }
      ${
        mayCreate
          ? html`<button class="link" @click=${() => this.store.openForm(rooms ? 'room' : 'group')}>
                ${plus} ${rooms ? t.newRoom : t.newGroup}
              </button>
              ${
                rooms
                  ? formView(forms, 'room', t.roomName, t.create)
                  : formView(forms, 'group', t.groupName, t.create)
              }`
          : nothing
      }
    `;
  }

  private roomDetail(t: Texts): TemplateResult | typeof nothing {
    const { store } = this;
    const room = store.room();
    if (room === undefined) {
      return nothing;
    }
    const detail = store.detailOf(room._id);
    const manages = detail?.rights.includes('manage') === true;
    const forms = this.forms(t);

    return roomView({
      t,
      room,
      head: headView(forms, room.name, manages, t.roomName, t.removeRoom),
      workpieces: store.state.workpieces,
      groups: store.state.groups,
      manages,
      edits: detail?.rights.includes('edit') === true,
      grants: detail?.grants,
      creates: this.newWorkpiece !== undefined,
      busy: store.state.busy,
      form: (kind, placeholder, label, value) => formView(forms, kind, placeholder, label, value),
      openForm: (kind) => store.openForm(kind),
      open: (workpiece) => this.open(workpiece, room),
      takeOut: (workpieceId) => void store.takeOut(room, workpieceId),
      toggle: (grant, chip) => void store.toggle(grant, chip),
      give: (groupId) => void store.give(room, groupId),
    });
  }

  private groupDetail(t: Texts): TemplateResult | typeof nothing {
    const { store } = this;
    const group = store.group();
    if (group === undefined) {
      return nothing;
    }
    const detail = store.detailOf(group._id);
    const manages = detail?.rights.includes('manage') === true;
    const { form } = store.state;
    const forms = this.forms(t);

    return groupView({
      t,
      group,
      head: headView(forms, group.name, manages, t.groupName, t.removeGroup),
      names: store.state.names,
      manages,
      grants: detail?.grants,
      searches: this.findPeople !== undefined,
      found: form?.kind === 'member' ? form.found : undefined,
      busy: store.state.busy,
      form: (kind, placeholder, label, value) => formView(forms, kind, placeholder, label, value),
      placeName: (scope) => store.placeName(scope),
      openForm: (kind) => store.openForm(kind),
      pick: (person) => void store.pick(group, person),
      dismiss: (actorId) => void store.dismiss(group, actorId),
      toggle: (grant, chip) => void store.toggle(grant, chip),
    });
  }

  /** What the head and the forms need: the open form, and the store behind them. */
  private forms(t: Texts): FormsView {
    const { store } = this;

    return {
      t,
      form: store.state.form,
      busy: store.state.busy,
      openForm: (kind) => store.openForm(kind),
      closeForm: () => store.closeForm(),
      clearError: () => store.clearError(),
      submit: (kind, text) => void store.submit(kind, text),
      removePlace: () => void store.removePlace(),
    };
  }

  /** Tells the tool which workpiece to open; what opening means is up to it. */
  private open(workpiece: Workpiece, room: Room): void {
    const detail: ManagementOpen = { workpiece, room };
    this.dispatchEvent(new CustomEvent('ck-open', { detail, bubbles: true, composed: true }));
  }
}
