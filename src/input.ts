/**
 * Values as they arrive from outside, typed unknown, and what they are taken for. Each
 * function answers undefined for anything that does not fit, so the caller decides how
 * to refuse. Shared by the HTTP routes and the WebSocket gateway.
 */

import { ObjectId, type Document } from 'mongodb';

const HEX24 = /^[0-9a-f]{24}$/i;

/**
 * An ObjectId from a path, a query or a body, undefined when it is not one. Checked
 * against the hex shape itself, so exactly a 24 digit hex string counts as a key,
 * whatever ObjectId.isValid may accept besides.
 */
export function asObjectId(raw: unknown): ObjectId | undefined {
  return typeof raw === 'string' && HEX24.test(raw) ? new ObjectId(raw) : undefined;
}

/**
 * The id of a reference as it arrives over JSON. Anything shaped like an ObjectId
 * becomes one, so the kinds the service keeps itself stay comparable. Everything
 * else is carried through as it came, because a tool may bundle ids of its own.
 */
export function asReferenceId(raw: unknown): unknown {
  return asObjectId(raw) ?? raw;
}

/** A string with something in it, undefined for everything else. */
export function asText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A plain object, which is the shape of every free field of the service. */
export function asObject(raw: unknown): Document | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Document)
    : undefined;
}

/** A whole number above zero, for a limit that arrived as text. */
export function asCount(raw: unknown): number | undefined {
  const value = Number(asText(raw));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
