/**
 * A page for elements in a Node test, from happy-dom. Only what Lit and the elements use becomes
 * global, so CK in the same test keeps fetch, URL and the rest of Node.
 */

import { Window } from 'happy-dom';

/** The page; closed after the tests so happy-dom leaves nothing running. */
export const page = new Window({ url: 'http://localhost/' });

/** What Lit and the elements reach for globally. */
const GLOBALS = [
  'document',
  'customElements',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLFormElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLButtonElement',
  'Document',
  'ShadowRoot',
  'CSSStyleSheet',
  'Event',
  'CustomEvent',
] as const;

// Set before Lit loads, as its classes extend HTMLElement as soon as they are imported.
for (const name of GLOBALS) {
  Object.defineProperty(globalThis, name, {
    value: page[name],
    configurable: true,
    writable: true,
  });
}
