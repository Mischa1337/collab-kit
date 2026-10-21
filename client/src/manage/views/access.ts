/** The access list of a room or a group: one row per grant, its rights as switches. */

import { html, type TemplateResult } from 'lit';

import type { Grant, Right } from '../../api.ts';
import { RIGHTS } from '../store.ts';

/** One grant: what it is about on the left, every right as a switch on the right. */
export function accessRow(
  label: string,
  grant: Grant,
  busy: boolean,
  toggle: (grant: Grant, right: Right) => void,
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
    </span>
  </div>`;
}
