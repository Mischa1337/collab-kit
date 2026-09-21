import { describe, expect, it } from 'vitest';

import { collectionDefinitions } from '../../src/db/schemas.ts';

describe('collectionDefinitions', () => {
  it('names every collection exactly once', () => {
    const names = collectionDefinitions.map((definition) => definition.name);

    expect(names).toEqual(['actors', 'documents', 'events', 'groups', 'rooms', 'updates']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('describes every collection as an object', () => {
    for (const definition of collectionDefinitions) {
      expect(definition.schema['bsonType']).toBe('object');
    }
  });

  it('gives every index a name of its own', () => {
    for (const definition of collectionDefinitions) {
      const names = (definition.indexes ?? []).map((index) => index.name);

      expect(names.every((name) => name !== undefined)).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
