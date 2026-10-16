import type { Document, ObjectId } from 'mongodb';

import { matchOptional } from '../utils/optional.ts';

/** The kinds the service keeps itself; only there can it decide who sees and does what. */
export const REFERENCE_KINDS = ['room', 'workpiece', 'group', 'comment', 'task'] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** Points at a whole thing of the service, so a rule on who sees it always applies. */
export interface Reference {
  kind: ReferenceKind;
  id: ObjectId;
}

/** Whether a value names one of the kinds the service keeps. */
export function isReferenceKind(kind: unknown): kind is ReferenceKind {
  return (REFERENCE_KINDS as readonly unknown[]).includes(kind);
}

/** A reference, optionally narrowed to one unit inside the thing as the tool defines it. */
export interface Anchor extends Reference {
  /** The key the tool gives a place inside. Text only, as a query can ask for nothing else. */
  unit?: string;
}

/** Database schema of the fields of a Reference, for schemas that embed one. */
export const referenceProperties = {
  kind: { enum: [...REFERENCE_KINDS] },
  id: { bsonType: 'objectId' },
} satisfies Document;

/** Database schema of an Anchor, for collections that embed one. */
export const anchorSchema: Document = {
  bsonType: 'object',
  required: ['kind', 'id'],
  properties: {
    ...referenceProperties,
    unit: { bsonType: 'string', description: 'the key the tool gives a place inside' },
  },
};

/** Unit value in an AnchorQuery that matches only anchors on the whole thing. */
export const WHOLE = null;

/** A search for anchors on one thing, optionally narrowed by unit. */
export interface AnchorQuery {
  readonly kind: ReferenceKind;
  readonly id: ObjectId;
  /** Omitted: the thing and all its units. WHOLE: the thing only. A key: that unit. */
  readonly unit?: string | typeof WHOLE;
}

/** Turns an AnchorQuery into a MongoDB filter on the field `anchor`. */
export function anchoredAt(target: AnchorQuery): Document {
  return {
    'anchor.kind': target.kind,
    'anchor.id': target.id,
    ...matchOptional('anchor.unit', target.unit),
  };
}
