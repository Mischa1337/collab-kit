/** Checks values from outside (HTTP, WebSocket), undefined whenever a value does not fit. */

import { ObjectId, type Document } from 'mongodb';

const HEX24 = /^[0-9a-f]{24}$/i;

/** Exactly 24 hex characters become an ObjectId, anything else undefined. */
export function asObjectId(raw: unknown): ObjectId | undefined {
  return typeof raw === 'string' && HEX24.test(raw) ? new ObjectId(raw) : undefined;
}

/** An ObjectId if the value looks like one, otherwise the value unchanged (own tool ids). */
export function asReferenceId(raw: unknown): unknown {
  return asObjectId(raw) ?? raw;
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

/** A whole number above zero, also from text like "20", otherwise undefined. */
export function asCount(raw: unknown): number | undefined {
  const value = Number(asText(raw));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
