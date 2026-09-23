import { describe, expect, it } from 'vitest';

import { defined, matchOptional } from '../../src/utils/optional.ts';

describe('defined', () => {
  it('leaves out what is undefined, key and all', () => {
    // toStrictEqual and not toEqual: toEqual would accept a key that holds undefined.
    expect(defined({ label: 'draft', reason: undefined })).toStrictEqual({ label: 'draft' });
  });

  it('keeps every other value, the empty ones included', () => {
    expect(defined({ unit: null, order: 0, text: '', flag: false })).toStrictEqual({
      unit: null,
      order: 0,
      text: '',
      flag: false,
    });
  });
});

describe('matchOptional', () => {
  it('asks nothing about a field that is left out', () => {
    expect(matchOptional('parentId', undefined)).toStrictEqual({});
  });

  it('asks for absence with null and for the value with anything else', () => {
    expect(matchOptional('parentId', null)).toStrictEqual({ parentId: { $exists: false } });
    expect(matchOptional('parentId', 'p-1')).toStrictEqual({ parentId: 'p-1' });
  });
});
