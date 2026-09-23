import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { anchoredAt, WHOLE } from '../../src/model/anchor.ts';

const id = new ObjectId();

describe('anchoredAt', () => {
  it('matches everything about a thing when no unit is named', () => {
    // No condition on the unit at all: the unit-bound anchors belong to the thing too.
    expect(anchoredAt({ kind: 'document', id })).toEqual({
      'anchor.kind': 'document',
      'anchor.id': id,
    });
  });

  it('narrows down to one unit', () => {
    expect(anchoredAt({ kind: 'document', id, unit: 'statement-3' })).toEqual({
      'anchor.kind': 'document',
      'anchor.id': id,
      'anchor.unit': 'statement-3',
    });
  });

  it('matches only the thing itself when asked for the whole', () => {
    expect(anchoredAt({ kind: 'document', id, unit: WHOLE })).toEqual({
      'anchor.kind': 'document',
      'anchor.id': id,
      'anchor.unit': { $exists: false },
    });
  });

  it('carries a unit of whatever shape the contract declared', () => {
    expect(anchoredAt({ kind: 'document', id, unit: { row: 4, column: 'name' } })).toMatchObject({
      'anchor.unit': { row: 4, column: 'name' },
    });
    expect(anchoredAt({ kind: 'document', id, unit: 17 })).toMatchObject({ 'anchor.unit': 17 });
  });

  it('points at things other than documents', () => {
    expect(anchoredAt({ kind: 'comment', id })).toMatchObject({ 'anchor.kind': 'comment' });
  });
});
