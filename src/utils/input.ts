/** Checks values from outside (HTTP, WebSocket), undefined whenever a value does not fit. */

import { ObjectId, type Document } from 'mongodb';

import type { Assignee } from '../db/collections/tasks.ts';
import type { UnitContainer } from '../db/collections/workpieces.ts';
import {
  isReferenceKind,
  REFERENCE_KINDS,
  WHOLE,
  type Anchor,
  type AnchorQuery,
  type Reference,
} from '../model/anchor.ts';
import { RIGHTS, type Right } from '../model/right.ts';
import { defined } from './optional.ts';

const HEX24 = /^[0-9a-f]{24}$/i;

/** Most maps a workpiece may name as holding units. */
const MAX_CONTAINERS = 20;

/** Most keys on the way from a root type down to such a map. */
const MAX_PATH = 10;

/** Exactly 24 hex characters become an ObjectId, anything else undefined. */
export function asObjectId(raw: unknown): ObjectId | undefined {
  return typeof raw === 'string' && HEX24.test(raw) ? new ObjectId(raw) : undefined;
}

/** An actor key as the token gives it: text kept as it is, or a finite number as text. */
export function asActorId(raw: unknown): string | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : asNonBlank(raw);
}

/** A trimmed string that is not empty, otherwise undefined. */
export function asText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A string that is not blank, kept as it is: trimmed, a key might no longer match. */
export function asNonBlank(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}

/** A plain object (not null, not an array), otherwise undefined. */
export function asObject(raw: unknown): Document | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Document)
    : undefined;
}

/** A list read entry by entry; one entry that does not fit spoils the whole list. */
export function asEvery<T>(raw: unknown, read: (entry: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const entries = raw.map((entry: unknown) => read(entry));
  return entries.every((entry): entry is T => entry !== undefined) ? entries : undefined;
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

/** The kinds as a sentence names them, for every rule that takes a reference. */
const KINDS_NAMED = `${REFERENCE_KINDS.slice(0, -1).join(', ')} or ${REFERENCE_KINDS.at(-1)}`;

/** What asReference needs, for the 400 of a route that takes a place. */
export const REFERENCE_RULE = `a place needs kind ${KINDS_NAMED} and an id of 24 hex characters`;

/** One of the service's own kinds and its key, from a body or a query; else undefined. */
export function asReference(raw: unknown): Reference | undefined {
  const fields = asObject(raw);
  const kind = fields?.['kind'];
  const id = asObjectId(fields?.['id']);

  return isReferenceKind(kind) && id !== undefined ? { kind, id } : undefined;
}

/** What asRights needs, for the 400 of a route that takes rights. */
export const RIGHTS_RULE = `rights must list at least one of ${RIGHTS.join(', ')}`;

/** At least one right, each known, each once; anything else makes the whole list unusable. */
export function asRights(raw: unknown): [Right, ...Right[]] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const entries = raw as unknown[];
  if (!entries.every((entry): entry is Right => (RIGHTS as readonly unknown[]).includes(entry))) {
    return undefined;
  }

  const [first, ...rest] = [...new Set(entries)];
  return first === undefined ? undefined : [first, ...rest];
}

/** What asAnchor needs, for the 400 of a route that takes an anchor in its body. */
export const ANCHOR_RULE = `anchor needs kind ${KINDS_NAMED}, an id of 24 hex characters, and a unit only as text`;

/** What asAnchorQuery needs, for the 400 of a route that reads an anchor from the query. */
export const ANCHOR_QUERY_RULE = `anchorKind must be ${KINDS_NAMED} and anchorId 24 hex characters, then unit or scope=whole`;

/** A reference with an optional unit; a unit sent but unusable makes the anchor unusable. */
export function asAnchor(raw: unknown): Anchor | undefined {
  const reference = asReference(raw);
  const sentUnit = asObject(raw)?.['unit'];
  const unit = asNonBlank(sentUnit);

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
    const unit = asNonBlank(sentUnit);
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
  return asEvery(raw, asAssignee);
}

/** Where the units lie: up to 20 maps, none also fine; one that does not fit spoils the list. */
export function asUnits(raw: unknown): UnitContainer[] | undefined {
  if (Array.isArray(raw) && raw.length > MAX_CONTAINERS) {
    return undefined;
  }
  return asEvery(raw, asUnitContainer);
}

/** One map by its path of 1 to 10 keys; another field too, and a later version would go unheard. */
function asUnitContainer(raw: unknown): UnitContainer | undefined {
  const fields = asObject(raw);
  const path = fields?.['path'];
  if (fields === undefined || Object.keys(fields).some((name) => name !== 'path')) {
    return undefined;
  }
  if (!Array.isArray(path) || path.length === 0 || path.length > MAX_PATH) {
    return undefined;
  }

  // Each key exactly as sent: trimmed, it would no longer match the one in the Y.Doc.
  const keys = asEvery(path, asNonBlank);
  return keys === undefined ? undefined : { path: keys };
}
