import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** The source of v1.d.ts as text: whatever it imports, a tool would have to install. */
const api = readFileSync(new URL('../../client/src/api.ts', import.meta.url), 'utf8');

describe('the description of the client library', () => {
  it('imports nothing, so a tool needs no Yjs even for the types', () => {
    expect(api).not.toMatch(/^\s*import\b/m);
    expect(api).not.toMatch(/\bimport\(/);
    expect(api).not.toMatch(/^\s*export\b[^;]*\bfrom\s*['"]/m);
  });
});
