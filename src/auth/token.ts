import jwt from 'jsonwebtoken';

import type { Actor } from '../actor.ts';

export interface TokenOptions {
  readonly secret: string;
  /** Seconds of clock difference tolerated between the issuing tool and this service. */
  readonly clockToleranceSeconds?: number;
}

/**
 * Raised for every rejection, always with the same message. Why a token failed is
 * kept in `cause` for the log and never told to the caller.
 */
export class TokenRejected extends Error {
  constructor(cause?: unknown) {
    super('token rejected', cause === undefined ? undefined : { cause });
    this.name = 'TokenRejected';
  }
}

/**
 * Binds the settings once and returns the check itself. The service verifies tokens,
 * it never issues them, so no signing function lives here. How long a token stays
 * valid is the decision of the issuing tool, taken over as it stands.
 */
export function createTokenCheck(options: TokenOptions): (token: string) => Actor {
  return (token: string): Actor => {
    let payload: unknown;
    try {
      payload = jwt.verify(token, options.secret, {
        // Pinned on purpose. Without it a forged header could pick another algorithm.
        algorithms: ['HS256'],
        clockTolerance: options.clockToleranceSeconds ?? 5,
      });
    } catch (cause) {
      throw new TokenRejected(cause);
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new TokenRejected(new Error('payload is not an object'));
    }

    const claims = payload as Record<string, unknown>;
    const subject = claims['sub'];
    if (typeof subject !== 'string' || subject.trim() === '') {
      throw new TokenRejected(new Error('claim sub is missing'));
    }

    const name = claims['name'];
    return typeof name === 'string' && name.trim() !== ''
      ? { actorId: subject, label: name }
      : { actorId: subject };
  };
}
