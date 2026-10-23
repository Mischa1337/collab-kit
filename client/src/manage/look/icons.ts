/** The few icons of <ck-management>, drawn in the color of the text around them. */

import { html, svg, type SVGTemplateResult, type TemplateResult } from 'lit';

/** One stroke icon of 16 by 16; hidden from screen readers, its button says what it does. */
function icon(path: SVGTemplateResult): TemplateResult {
  return html`<svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${path}
  </svg>`;
}

export const plus = icon(svg`<path d="M8 3v10M3 8h10" />`);
export const cross = icon(svg`<path d="M4 4l8 8M12 4l-8 8" />`);
export const forward = icon(svg`<path d="M3 8h10M9 4l4 4-4 4" />`);
