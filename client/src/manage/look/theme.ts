/** How <ck-management> looks: its own scheme, every color a --ck-* variable the tool may set. */

import { css } from 'lit';

// Each value holds only while the tool sets no --ck-* of its own.
const light = css`
  --surface: var(--ck-surface, #ffffff);
  --surface-alt: var(--ck-surface-alt, #f1efe8);
  --text: var(--ck-text, #2c2c2a);
  --text-muted: var(--ck-text-muted, #5f5e5a);
  --border: var(--ck-border, #d3d1c7);
  --accent: var(--ck-accent, #534ab7);
  --on-accent: var(--ck-on-accent, #ffffff);
  --danger: var(--ck-danger, #a32d2d);
`;

const dark = css`
  --surface: var(--ck-surface, #1f1e1d);
  --surface-alt: var(--ck-surface-alt, #2c2c2a);
  --text: var(--ck-text, #f1efe8);
  --text-muted: var(--ck-text-muted, #b4b2a9);
  --border: var(--ck-border, #444441);
  --accent: var(--ck-accent, #afa9ec);
  --on-accent: var(--ck-on-accent, #26215c);
  --danger: var(--ck-danger, #f09595);
`;

/** The styles of the shadow DOM; the font comes from the page around it. */
export const styles = css`
  :host {
    ${light}
    --radius: var(--ck-radius, 8px);
    display: block;
    container-type: inline-size;
    color: var(--text);
  }
  :host([theme='dark']) {
    ${dark}
  }
  @media (prefers-color-scheme: dark) {
    :host(:not([theme='light'])) {
      ${dark}
    }
  }
  * {
    box-sizing: border-box;
  }
  .frame {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    font-size: 14px;
    line-height: 1.5;
  }
  .bar {
    display: flex;
    gap: 4px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .body {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    min-height: 320px;
  }
  .list {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    padding: 8px;
    border-right: 1px solid var(--border);
  }
  .detail {
    padding: 12px 16px;
  }
  @container (max-width: 520px) {
    .body {
      grid-template-columns: minmax(0, 1fr);
    }
    .list {
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
  }
  h2 {
    font-size: 16px;
    font-weight: 500;
    margin: 0;
  }
  h3 {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-muted);
    margin: 16px 0 4px;
  }
  p {
    margin: 0;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  input,
  select {
    font: inherit;
    color: inherit;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    padding: 4px 8px;
    min-width: 0;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .tab,
  .item {
    padding: 4px 12px;
    border-radius: calc(var(--radius) - 2px);
    color: var(--text-muted);
  }
  .tab[aria-selected='true'] {
    background: var(--accent);
    color: var(--on-accent);
  }
  .item {
    text-align: left;
    padding: 6px 10px;
  }
  .item[aria-current='true'] {
    background: var(--surface-alt);
    color: var(--text);
  }
  .head,
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .row {
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }
  .actions,
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
  }
  .chips {
    gap: 4px;
  }
  .chip {
    font-size: 12px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    color: var(--text-muted);
  }
  .chip[aria-pressed='true'] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 0;
    font-size: 13px;
    color: var(--accent);
  }
  .danger {
    color: var(--danger);
  }
  .button {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
  }
  .button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .form,
  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .form input,
  .form select {
    flex: 1;
  }
  .confirm p {
    flex-basis: 100%;
  }
  .key {
    margin-left: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .empty,
  .hint {
    padding: 6px 0;
    font-size: 13px;
    color: var(--text-muted);
  }
  .hint {
    padding: 4px 0 0;
    font-size: 12px;
  }
  .error {
    margin-top: 6px;
    font-size: 13px;
    color: var(--danger);
  }
  .banner {
    margin: 0;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
`;
