/** One room: its workpieces, and what each group may do there. */

import { html, nothing, type TemplateResult } from 'lit';

import type { Grant, Group, Right, Room, Workpiece } from '../../api.ts';
import { cross, forward, plus } from '../look/icons.ts';
import type { Texts } from '../look/texts.ts';
import { accessRow } from './access.ts';
import type { Slot } from './forms.ts';

/** What the room view shows, and what it may ask the element for. */
export interface RoomView {
  readonly t: Texts;
  readonly room: Room;
  /** Name, rename and delete, the same as for a group. */
  readonly head: TemplateResult;
  readonly workpieces: ReadonlyMap<string, Workpiece>;
  readonly groups: readonly Group[];
  /** Whether the own person holds manage at the room. */
  readonly manages: boolean;
  /** The grants at the room, read only with manage there. */
  readonly grants: readonly Grant[] | undefined;
  /** Whether the tool gave newWorkpiece, so workpieces can be created here. */
  readonly creates: boolean;
  readonly busy: boolean;
  readonly form: Slot;
  openForm(kind: 'workpiece'): void;
  open(workpiece: Workpiece): void;
  takeOut(workpieceId: string): void;
  toggle(grant: Grant, right: Right): void;
  give(groupId: string): void;
}

/** The room with its workpieces, and with manage the groups that may do something here. */
export function roomView(view: RoomView): TemplateResult {
  const { t, room } = view;

  return html`
    ${view.head}
    <h3>${t.workpieces}</h3>
    ${
      room.workpieces.length === 0
        ? html`<p class="empty">${t.noWorkpieces}</p>`
        : room.workpieces.map((id) => workpieceRow(view, id))
    }
    ${
      view.manages && view.creates
        ? html`<button class="link" @click=${() => view.openForm('workpiece')}>
              ${plus} ${t.newWorkpiece}
            </button>
            ${view.form('workpiece', t.workpieceName, t.create)}`
        : nothing
    }
    ${view.grants === undefined ? nothing : accessView(view, view.grants)}
  `;
}

/** One workpiece; the tool decides what opening means, CK only says which. */
function workpieceRow(view: RoomView, id: string): TemplateResult {
  const { t } = view;
  const workpiece = view.workpieces.get(id);

  return html`<div class="row">
    <span>${workpiece?.name ?? id}</span>
    <span class="actions">
      ${
        workpiece === undefined
          ? nothing
          : html`<button class="link" @click=${() => view.open(workpiece)}>
              ${t.open} ${forward}
            </button>`
      }
      ${
        view.manages
          ? html`<button
              class="link danger"
              aria-label=${t.takeOut}
              title=${t.takeOut}
              ?disabled=${view.busy}
              @click=${() => view.takeOut(id)}
            >
              ${cross}
            </button>`
          : nothing
      }
    </span>
  </div>`;
}

/** The grants at the room, and a group without one to give access to. */
function accessView(view: RoomView, grants: readonly Grant[]): TemplateResult {
  const { t } = view;
  const nameOf = (groupId: string) =>
    view.groups.find((group) => group._id === groupId)?.name ?? groupId;
  const without = view.groups.filter(
    (group) => !grants.some((grant) => grant.groupId === group._id),
  );

  // The select is read on submit, so nothing has to follow each choice.
  const give = (event: SubmitEvent) => {
    event.preventDefault();
    const select = (event.currentTarget as HTMLFormElement).querySelector('select');
    if (select !== null) {
      view.give(select.value);
    }
  };

  return html`
    <h3>${t.access}</h3>
    ${
      grants.length === 0
        ? html`<p class="empty">${t.noAccess}</p>`
        : grants.map((grant) => accessRow(nameOf(grant.groupId), grant, view.busy, view.toggle))
    }
    <p class="hint">${t.alsoEverywhere}</p>
    ${
      without.length === 0
        ? nothing
        : html`<form class="form" @submit=${give}>
            <select aria-label=${t.giveAccess}>
              ${without.map((group) => html`<option value=${group._id}>${group.name}</option>`)}
            </select>
            <button class="button" type="submit" ?disabled=${view.busy}>${t.giveAccess}</button>
          </form>`
    }
  `;
}
