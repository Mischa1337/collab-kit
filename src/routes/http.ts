/** What every route file needs from Express; plain values are checked in utils/input.ts. */

import type { Request, RequestHandler, RequestParamHandler, Response } from 'express';
import type { Document, ObjectId } from 'mongodb';

import type { Actor } from '../model/actor.ts';
import { asObject, asObjectId } from '../utils/input.ts';

/** Every refusal answers in the same shape, so a client parses one thing. */
export function fail(response: Response, status: number, error: string): void {
  response.status(status).json({ error });
}

/** The actor requireActor set; none means a route sits outside it, a wiring mistake. */
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

/** The first optional field that was sent but read as nothing; dropping it would go unnoticed. */
export function unusableField(
  sent: Record<string, unknown>,
  read: Record<string, unknown>,
): string | undefined {
  return Object.keys(read).find((name) => sent[name] !== undefined && read[name] === undefined);
}

/** Refuses an :id that is no ObjectId; registered once per router with routes.param. */
export function requireId(what: string): RequestParamHandler {
  return (_request, response, next, raw) => {
    if (asObjectId(raw) === undefined) {
      return fail(response, 400, `malformed ${what} key`);
    }
    next();
  };
}

/** The :id requireId let through; none means the router skipped requireId, a wiring mistake. */
export function idOf(request: Request): ObjectId {
  const id = asObjectId(request.params['id']);

  if (id === undefined) {
    throw new Error('route takes an id without requireId');
  }
  return id;
}

/** Lets a request through only if the rule says yes; placed in front of a handler. */
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
