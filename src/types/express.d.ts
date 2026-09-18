import type { Actor } from '../auth/token.ts';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireActor once the token has been verified. */
    actor?: Actor;
  }
}
