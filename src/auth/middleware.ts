import type { RequestHandler } from 'express';

import type { Actor } from '../actor.ts';
import { TokenRejected } from './token.ts';

const BEARER = 'Bearer ';

/**
 * Reads the token from the Authorization header and hangs the actor on the request.
 * Every rejection answers alike, so nobody can tell a wrong signature from an
 * expired token by trying.
 */
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
