/** The access list of a room or a group: one row per grant, its rights as switches. */

import { html, type TemplateResult } from 'lit';

import type { Grant } from '../../api.ts';
import { RIGHTS, type Switch } from '../store.ts';

/** One grant: what it is about on the left, every right and the flag as a switch on the right. */
export function accessRow(
  label: string,
  grant: Grant,
  busy: boolean,
  toggle: (grant: Grant, chip: Switch) => void,
): TemplateResult {
  return html`<div class="row">
    <span>${label}</span>
    <span class="chips">
      ${RIGHTS.map(
        (right) =>
          html`<button
            class="chip"
            aria-pressed=${grant.rights.includes(right)}
            ?disabled=${busy}
            @click=${() => toggle(grant, right)}
          >
            ${right}
          </button>`,
      )}
      <button
        class="chip"
        aria-pressed=${grant.anonymous === true}
        ?disabled=${busy}
        @click=${() => toggle(grant, 'anonymous')}
      >
        anonymous
      </button>
    </span>
  </div>`;
}
