/** Checks values from outside (HTTP, WebSocket), undefined whenever a value does not fit. */

import { ObjectId, type Document } from 'mongodb';

import type { Assignee } from '../db/collections/tasks.ts';
import { WHOLE, type Anchor, type AnchorQuery, type Reference } from '../model/anchor.ts';
import { defined } from './optional.ts';

const HEX24 = /^[0-9a-f]{24}$/i;

/** Exactly 24 hex characters become an ObjectId, anything else undefined. */
export function asObjectId(raw: unknown): ObjectId | undefined {
  return typeof raw === 'string' && HEX24.test(raw) ? new ObjectId(raw) : undefined;
}

/** Text only, as an object would reach MongoDB as an operator; ObjectId if it looks like one. */
export function asReferenceId(raw: unknown): ObjectId | string | undefined {
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  return asObjectId(raw) ?? raw;
}

/** An actor key as the token gives it: text kept as it is, or a finite number as text. */
export function asActorId(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    return raw.trim() === '' ? undefined : raw;
  }
  return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined;
}

/** A trimmed string that is not empty, otherwise undefined. */
export function asText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A plain object (not null, not an array), otherwise undefined. */
export function asObject(raw: unknown): Document | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Document)
    : undefined;
}

/** A finite number as sent in a body, fractions and negatives included, otherwise undefined. */
export function asNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** A whole number above zero, also from text like "20", otherwise undefined. */
export function asCount(raw: unknown): number | undefined {
  const value = Number(asText(raw));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Kind and id of a reference, from a body or a query; undefined if either does not fit. */
export function asReference(raw: unknown): Reference | undefined {
  const fields = asObject(raw);
  const kind = asText(fields?.['kind']);
  const id = asReferenceId(fields?.['id']);

  return kind === undefined || id === undefined ? undefined : { kind, id };
}

/** What asAnchor needs, for the 400 of a route that takes an anchor in its body. */
export const ANCHOR_RULE = 'anchor needs kind and id, and a unit only as text';

/** What asAnchorQuery needs, for the 400 of a route that reads an anchor from the query. */
export const ANCHOR_QUERY_RULE = 'anchorKind and anchorId are needed, then unit or scope=whole';

/** A reference with an optional unit; a unit sent but unusable makes the anchor unusable. */
export function asAnchor(raw: unknown): Anchor | undefined {
  const reference = asReference(raw);
  const sentUnit = asObject(raw)?.['unit'];
  const unit = asUnit(sentUnit);

  if (reference === undefined || (sentUnit !== undefined && unit === undefined)) {
    return undefined;
  }
  return { ...reference, ...defined({ unit }) };
}

/** The anchor from a flat query: no unit is all of it, scope=whole the thing, a unit one place. */
export function asAnchorQuery(query: Record<string, unknown>): AnchorQuery | undefined {
  const reference = asReference({ kind: query['anchorKind'], id: query['anchorId'] });
  const sentUnit = query['unit'];
  const sentScope = query['scope'];

  // One place and the thing alone contradict each other; neither may be dropped unnoticed.
  if (reference === undefined || (sentUnit !== undefined && sentScope !== undefined)) {
    return undefined;
  }
  if (sentScope !== undefined) {
    return sentScope === 'whole' ? { ...reference, unit: WHOLE } : undefined;
  }
  if (sentUnit !== undefined) {
    const unit = asUnit(sentUnit);
    return unit === undefined ? undefined : { ...reference, unit };
  }
  return reference;
}

/** A parent from a query: none for what has no parent (null), else the ObjectId of the parent. */
export function asParentId(raw: unknown): ObjectId | null | undefined {
  return raw === 'none' ? null : asObjectId(raw);
}

/** What asAssignee needs, for the 400 of a route that takes one assignee or a list of them. */
export const ASSIGNEE_RULE = 'an assignee needs kind actor or group and an id of that kind';

/** A person by actor key as the token gives it, a group by its ObjectId; nothing else. */
export function asAssignee(raw: unknown): Assignee | undefined {
  const fields = asObject(raw);
  const kind = fields?.['kind'];

  if (kind === 'actor') {
    const id = asActorId(fields?.['id']);
    return id === undefined ? undefined : { kind, id };
  }
  if (kind === 'group') {
    const id = asObjectId(fields?.['id']);
    return id === undefined ? undefined : { kind, id };
  }
  return undefined;
}

/** A list of assignees as asAssignee reads each; one entry that does not fit spoils the list. */
export function asAssignees(raw: unknown): Assignee[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const assignees = raw.map((entry: unknown) => asAssignee(entry));
  return assignees.every((entry): entry is Assignee => entry !== undefined) ? assignees : undefined;
}

/** The key the tool gives a place: text kept as it is, not blank. A query can send nothing else. */
function asUnit(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}
