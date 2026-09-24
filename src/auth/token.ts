import { createPublicKey, createSecretKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Actor } from '../model/actor.ts';

/** Every algorithm a docking tool may sign with. `none` is left out on purpose. */
export const TOKEN_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
] as const;

export type TokenAlgorithm = (typeof TOKEN_ALGORITHMS)[number];

export function isTokenAlgorithm(value: string): value is TokenAlgorithm {
  return (TOKEN_ALGORITHMS as readonly string[]).includes(value);
}

/** HS algorithms check against a secret both sides share, all others against a public key. */
export function usesSharedSecret(algorithm: string): boolean {
  return algorithm.startsWith('HS');
}

export interface TokenOptions {
  /** The shared secret for an HS algorithm, the tool's public key as PEM for any other. */
  readonly key: string;
  /** Pinned per instance, `HS256` unless the issuing tool signs otherwise. */
  readonly algorithm?: TokenAlgorithm;
  /** Seconds of clock difference tolerated between the issuing tool and this service. */
  readonly clockToleranceSeconds?: number;
  /** Claim that holds the actor key, `sub` unless the issuing tool puts it elsewhere. */
  readonly actorClaim?: string;
  /** Claim that holds the name to show, `name` unless the issuing tool puts it elsewhere. */
  readonly labelClaim?: string;
}

/** One message for every rejection, the reason stays in `cause` for the log only. */
export class TokenRejected extends Error {
  constructor(cause?: unknown) {
    super('token rejected', cause === undefined ? undefined : { cause });
    this.name = 'TokenRejected';
  }
}

/** Returns the check; algorithm and claims are fixed per instance, never read from a token. */
export function createTokenCheck(options: TokenOptions): (token: string) => Actor {
  const algorithm = options.algorithm ?? 'HS256';
  const actorClaim = options.actorClaim ?? 'sub';
  const labelClaim = options.labelClaim ?? 'name';

  // Read once, so a broken key stops the start instead of failing every request.
  const key = usesSharedSecret(algorithm)
    ? createSecretKey(Buffer.from(options.key))
    : createPublicKey(options.key);

  return (token: string): Actor => {
    let payload: unknown;
    try {
      payload = jwt.verify(token, key, {
        // Pinned on purpose. Without it a forged header could pick another algorithm.
        algorithms: [algorithm],
        clockTolerance: options.clockToleranceSeconds ?? 5,
      });
    } catch (cause) {
      throw new TokenRejected(cause);
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new TokenRejected(new Error('payload is not an object'));
    }

    const claims = payload as Record<string, unknown>;
    const actorId = asActorId(claims[actorClaim]);
    if (actorId === undefined) {
      throw new TokenRejected(new Error(`claim ${actorClaim} holds no usable key`));
    }

    const name = claims[labelClaim];
    return typeof name === 'string' && name.trim() !== '' ? { actorId, label: name } : { actorId };
  };
}

/** Text that is not blank, or a finite number for tools that number their users. */
function asActorId(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    return raw.trim() === '' ? undefined : raw;
  }
  return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined;
}
