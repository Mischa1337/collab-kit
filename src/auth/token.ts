import { createPublicKey, createSecretKey, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Actor } from '../model/actor.ts';
import { asActorId } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';

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

/** A claim and the values in it that put an actor at the top, where every right holds everywhere. */
export interface TopClaim {
  readonly claim: string;
  readonly values: readonly string[];
}

/** Finds the key a token names by the kid in its header. */
export type KeyLookup = (kid: string | undefined) => Promise<KeyObject>;

export interface TokenOptions {
  /** The shared secret for an HS algorithm, the tool's public key as PEM, or a lookup into its key set. */
  readonly key: string | KeyLookup;
  /** Pinned per instance; the configuration holds the only default. */
  readonly algorithm: TokenAlgorithm;
  /** Seconds of clock difference tolerated between the issuing tool and this service. */
  readonly clockToleranceSeconds?: number;
  /** Claim that holds the actor key, `sub` unless the issuing tool puts it elsewhere. */
  readonly actorClaim?: string;
  /** Claim that holds the name to show, `name` unless the issuing tool puts it elsewhere. */
  readonly labelClaim?: string;
  /** Required `iss`; left out, every issuer passes. */
  readonly issuer?: string;
  /** Accepted `aud` values, one must match; left out or empty, every audience passes. */
  readonly audience?: readonly string[];
  /** Who stands at the top, as the docking tool names it; left out, nobody does. */
  readonly top?: TopClaim;
}

/** One message for every rejection, the reason stays in `cause` for the log only. */
export class TokenRejected extends Error {
  constructor(cause?: unknown) {
    super('token rejected', cause === undefined ? undefined : { cause });
    this.name = 'TokenRejected';
  }
}

/** Returns the check; algorithm and claims are fixed per instance, never read from a token. */
export function createTokenCheck(options: TokenOptions): (token: string) => Promise<Actor> {
  const algorithm = options.algorithm;
  const actorClaim = options.actorClaim ?? 'sub';
  const labelClaim = options.labelClaim ?? 'name';

  // A fixed key is read once, so a broken one stops the start instead of failing every request.
  const lookup = typeof options.key === 'function' ? options.key : fixedKey(options.key, algorithm);

  const verifyOptions: jwt.VerifyOptions = {
    // Pinned on purpose. Without it a forged header could pick another algorithm.
    algorithms: [algorithm],
    clockTolerance: options.clockToleranceSeconds ?? 5,
    ...defined({ issuer: options.issuer, audience: audienceOption(options.audience) }),
  };

  return async (token: string): Promise<Actor> => {
    let payload: unknown;
    try {
      const header = readHeader(token);
      // Refused before any key is looked up, so a foreign algorithm never makes the set reload.
      if (header.alg !== algorithm) {
        throw new Error(`token is signed with ${header.alg}`);
      }
      const key = await lookup(header.kid);
      payload = jwt.verify(token, key, verifyOptions);
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
    const label = typeof name === 'string' && name.trim() !== '' ? name : undefined;

    return { actorId, ...defined({ label, top: topOf(claims, options.top) }) };
  };
}

/** True when the top claim holds one of its values, alone or in a list; else nothing at all. */
function topOf(claims: Record<string, unknown>, top: TopClaim | undefined): true | undefined {
  if (top === undefined) {
    return undefined;
  }

  // A claim may carry one value, like globalRole, or a list of them, like roles.
  const value = claims[top.claim];
  const entries = Array.isArray(value) ? (value as unknown[]) : [value];

  return entries.some((entry) => typeof entry === 'string' && top.values.includes(entry))
    ? true
    : undefined;
}

/** One key for every token: the secret for an HS algorithm, the public key for any other. */
function fixedKey(key: string, algorithm: TokenAlgorithm): KeyLookup {
  const fixed = usesSharedSecret(algorithm)
    ? createSecretKey(Buffer.from(key))
    : createPublicKey(key);
  return () => Promise.resolve(fixed);
}

/** The header, read without any check, only to learn which algorithm and key the token names. */
function readHeader(token: string): jwt.JwtHeader {
  const decoded = jwt.decode(token, { complete: true });
  if (decoded === null) {
    throw new Error('token is malformed');
  }
  return decoded.header;
}

/** jsonwebtoken wants a list with at least one entry; an empty one means no check. */
function audienceOption(
  audience: readonly string[] | undefined,
): [string, ...string[]] | undefined {
  const [first, ...rest] = audience ?? [];
  return first === undefined ? undefined : [first, ...rest];
}
