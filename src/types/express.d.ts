import type { Actor } from '../model/actor.ts';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireActor once the token has been verified. */
    actor?: Actor;
  }
}
