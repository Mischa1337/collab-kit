/** Entry of manage-v1.js: registers <ck-management>, which works with the ck of v1.js. */

import { Management } from './management.ts';

// A page that loads the file twice keeps the first, a second definition would throw.
if (customElements.get('ck-management') === undefined) {
  customElements.define('ck-management', Management);
}
