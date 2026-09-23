import type { Request, Response } from 'express';
import { ObjectId, type Document } from 'mongodb';

import type { Actor } from '../auth/token.ts';

const HEX24 = /^[0-9a-f]{24}$/i;

/**
 * An ObjectId from a path parameter or a query, undefined when it is not one.
 * Checked against the hex shape and not with ObjectId.isValid, which also accepts
 * numbers and any twelve byte string.
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

/** Every refusal answers in the same shape, so a client parses one thing. */
export function fail(response: Response, status: number, error: string): void {
  response.status(status).json({ error });
}

/**
 * The actor requireActor hung on the request. Throwing here would mean a route was
 * mounted outside the guard, which is a mistake in the wiring and not in the request.
 */
export function actorOf(request: Request): Actor {
  const actor = request.actor;

  if (actor === undefined) {
    throw new Error('route is mounted outside requireActor');
  }
  return actor;
}

/** The body as an object, so a request without one reads like an empty one. */
export function bodyOf(request: Request): Document {
  return asObject(request.body) ?? {};
}
