import type { Actor } from '../actor.ts';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireActor once the token has been verified. */
    actor?: Actor;
  }
}
