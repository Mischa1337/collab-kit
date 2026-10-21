/** One group: its members, and what it may do where. */

import { html, nothing, type TemplateResult } from 'lit';

import type { ActorName, Grant, Group, Reference, Right } from '../../api.ts';
import { cross, plus } from '../look/icons.ts';
import type { Texts } from '../look/texts.ts';
import { accessRow } from './access.ts';
import type { Slot } from './forms.ts';

/** What the group view shows, and what it may ask the element for. */
export interface GroupView {
  readonly t: Texts;
  readonly group: Group;
  /** Name, rename and delete, the same as for a room. */
  readonly head: TemplateResult;
  /** Names to the keys of members, as far as CK or the tool knows one. */
  readonly names: Readonly<Record<string, string>>;
  /** Whether the own person holds manage at the group. */
  readonly manages: boolean;
  /** The grants of the group wherever they are, read only with manage at it. */
  readonly grants: readonly Grant[] | undefined;
  /** Whether the tool gave findPeople, so a member is searched and not typed as a key. */
  readonly searches: boolean;
  /** The people findPeople gave, when it was more than one. */
  readonly found: readonly ActorName[] | undefined;
  readonly busy: boolean;
  readonly form: Slot;
  placeName(scope: Reference | undefined): string;
  openForm(kind: 'member'): void;
  pick(person: ActorName): void;
  dismiss(actorId: string): void;
  toggle(grant: Grant, right: Right): void;
}

/** The group with its members, and with manage the places where it may do something. */
export function groupView(view: GroupView): TemplateResult {
  const { t, group } = view;

  return html`
    ${view.head}
    <h3>${t.members}</h3>
    ${
      group.members.length === 0
        ? html`<p class="empty">${t.noMembers}</p>`
        : group.members.map((actorId) => memberRow(view, actorId))
    }
    ${
      view.manages
        ? html`<button class="link" @click=${() => view.openForm('member')}>
              ${plus} ${t.addMember}
            </button>
            ${view.form('member', view.searches ? t.memberSearch : t.memberKey, t.add)}
            ${view.found === undefined ? nothing : foundView(view, view.found)}`
        : nothing
    }
    ${
      view.grants === undefined
        ? nothing
        : html`<h3>${t.groupAccess}</h3>
            ${
              view.grants.length === 0
                ? html`<p class="empty">${t.groupHasNone}</p>`
                : view.grants.map((grant) =>
                    accessRow(view.placeName(grant.scope), grant, view.busy, view.toggle),
                  )
            }`
    }
  `;
}

/** One member by name, its key beside it; without a name only the key. */
function memberRow(view: GroupView, actorId: string): TemplateResult {
  const { t } = view;
  const name = view.names[actorId];

  return html`<div class="row">
    <span>
      ${name ?? actorId}${name === undefined ? nothing : html`<span class="key">${actorId}</span>`}
    </span>
    ${
      view.manages
        ? html`<button
            class="link danger"
            aria-label=${t.dismiss}
            title=${t.dismiss}
            ?disabled=${view.busy}
            @click=${() => view.dismiss(actorId)}
          >
            ${cross}
          </button>`
        : nothing
    }
  </div>`;
}

/** The people findPeople gave, one of them to pick. */
function foundView(view: GroupView, found: readonly ActorName[]): TemplateResult {
  return html`<p class="hint">${view.t.pick}</p>
    <div class="chips">
      ${found.map(
        (person) =>
          html`<button class="chip" ?disabled=${view.busy} @click=${() => view.pick(person)}>
            ${person.label ?? person.actorId}
          </button>`,
      )}
    </div>`;
}
