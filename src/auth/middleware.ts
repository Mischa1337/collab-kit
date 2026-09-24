import type { RequestHandler } from 'express';

import type { Actor } from '../model/actor.ts';
import { TokenRejected } from './token.ts';

const BEARER = 'Bearer ';

/** Hangs the actor from the Bearer token on the request; every rejection answers the same 401. */
export function requireActor(
  check: (token: string) => Actor,
  onRejected?: (error: unknown) => void,
): RequestHandler {
  return (request, response, next) => {
    const header = request.get('authorization');

    if (header === undefined || !header.startsWith(BEARER)) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }

    try {
      request.actor = check(header.slice(BEARER.length));
      next();
    } catch (error) {
      onRejected?.(error instanceof TokenRejected ? error : new TokenRejected(error));
      response.status(401).json({ error: 'unauthorized' });
    }
  };
}
