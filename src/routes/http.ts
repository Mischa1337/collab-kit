/**
 * What every route file needs from Express: refusing in one shape, reading the actor,
 * the body and the id, and guarding a route. Reading plain values is in input.ts.
 */

import type { Request, RequestHandler, RequestParamHandler, Response } from 'express';
import type { Document, ObjectId } from 'mongodb';

import type { Actor } from '../actor.ts';
import { asObject, asObjectId } from '../input.ts';

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

/**
 * Refuses a request whose :id is not an ObjectId before any handler sees it.
 * Registered once per router with routes.param('id', ...), so no route repeats it.
 */
export function requireId(what: string): RequestParamHandler {
  return (_request, response, next, raw) => {
    if (asObjectId(raw) === undefined) {
      return fail(response, 400, `malformed ${what} key`);
    }
    next();
  };
}

/**
 * The :id that requireId let through. Throwing here would mean a router takes an id
 * without checking it, which is a mistake in the wiring, as in actorOf.
 */
export function idOf(request: Request): ObjectId {
  const id = asObjectId(request.params['id']);

  if (id === undefined) {
    throw new Error('route takes an id without requireId');
  }
  return id;
}

/**
 * Lets a request through only when the rule says yes, and refuses it otherwise.
 * Placed in front of a handler, so a route shows what it demands where it is declared.
 */
export function guard(
  rule: (actor: Actor, id: ObjectId) => Promise<boolean>,
  status: number,
  error: string,
): RequestHandler {
  return async (request, response, next) => {
    if (!(await rule(actorOf(request), idOf(request)))) {
      return fail(response, status, error);
    }
    next();
  };
}
