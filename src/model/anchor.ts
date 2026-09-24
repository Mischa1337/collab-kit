import type { Document } from 'mongodb';

import { matchOptional } from '../utils/optional.ts';

/** Points at a whole thing. Kind is free, the service resolves only its own kinds. */
export interface Reference {
  kind: string;
  id: unknown;
}

/** A reference, optionally narrowed to one unit inside the thing as the tool defines it. */
export interface Anchor extends Reference {
  unit?: unknown;
}

/** Database schema of a Reference, for collections that embed one. */
export const referenceSchema: Document = {
  bsonType: 'object',
  required: ['kind', 'id'],
  properties: {
    kind: { bsonType: 'string' },
    id: {},
  },
};

/** Database schema of an Anchor, for collections that embed one. */
export const anchorSchema: Document = {
  bsonType: 'object',
  required: ['kind', 'id'],
  properties: {
    kind: { bsonType: 'string' },
    id: {},
    unit: { description: 'the unit inside, shaped as the contract of the tool declares' },
  },
};

/** Unit value in an AnchorQuery that matches only anchors on the whole thing. */
export const WHOLE = null;

/** A search for anchors on one thing, optionally narrowed by unit. */
export interface AnchorQuery {
  readonly kind: string;
  readonly id: unknown;
  /** Omitted: the thing and all its units. WHOLE: the thing only. Any value: that unit. */
  readonly unit?: unknown;
}

/** Turns an AnchorQuery into a MongoDB filter on the field `anchor`. */
export function anchoredAt(target: AnchorQuery): Document {
  return {
    'anchor.kind': target.kind,
    'anchor.id': target.id,
    ...matchOptional('anchor.unit', target.unit),
  };
}
