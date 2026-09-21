import type { Document } from 'mongodb';

/**
 * A pointer to a thing. The kind is a free string: the service resolves only the
 * kinds it keeps itself and carries the others through untouched.
 */
export interface Reference {
  kind: string;
  id: unknown;
}

/**
 * A reference that may narrow down to a single unit inside the thing. Which units
 * exist and how they are recognised is what the tool declared in the `contract` of
 * its document; the service carries the value and never resolves it.
 *
 * Without `unit` the anchor points at the whole thing, with it at one place inside.
 * That difference is all there is to local versus global feedback.
 */
export interface Anchor extends Reference {
  unit?: unknown;
}

/** The `$jsonSchema` of a plain reference, for collections that embed one. */
export const referenceSchema: Document = {
  bsonType: 'object',
  required: ['kind', 'id'],
  properties: {
    kind: { bsonType: 'string' },
    id: {},
  },
};

/** The same with the optional unit. */
export const anchorSchema: Document = {
  bsonType: 'object',
  required: ['kind', 'id'],
  properties: {
    kind: { bsonType: 'string' },
    id: {},
    unit: { description: 'the unit inside, shaped as the contract of the tool declares' },
  },
};

/** Matches anchors on the thing as a whole, leaving out everything unit-bound. */
export const WHOLE = null;

export interface AnchorQuery {
  readonly kind: string;
  readonly id: unknown;
  /**
   * Left out, this matches every anchor on the thing, unit-bound ones included, which
   * is what "everything about this document" means. WHOLE matches only the anchors on
   * the thing itself. Any other value matches exactly that unit.
   */
  readonly unit?: unknown;
}

/**
 * Builds the filter for a field named `anchor`. It sits here and not in the three
 * collections that use it, so the question what a missing unit means is answered
 * once instead of three times.
 */
export function anchoredAt(target: AnchorQuery): Document {
  const filter: Document = { 'anchor.kind': target.kind, 'anchor.id': target.id };

  if (target.unit === WHOLE) {
    filter['anchor.unit'] = { $exists: false };
  } else if (target.unit !== undefined) {
    filter['anchor.unit'] = target.unit;
  }

  return filter;
}
