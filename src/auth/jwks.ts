import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { Logger } from 'pino';

import type { KeyLookup, TokenAlgorithm } from './token.ts';

/** Least time between two loads, so tokens with made-up kids cannot flood the issuer. */
const RELOAD_COOLDOWN_MS = 60_000;

/** Age after which the set is loaded again, so a key the issuer withdrew stops counting. */
const MAX_AGE_MS = 10 * 60_000;

/** Time one load may take, so a hanging issuer cannot hold requests forever. */
const FETCH_TIMEOUT_MS = 5_000;

export interface KeySetOptions {
  /** Where the issuing tool publishes its public keys as a JWKS (RFC 7517). */
  readonly uri: string;
  /** The algorithm pinned for the instance, RS, PS or ES; keys for any other are left out. */
  readonly algorithm: TokenAlgorithm;
  readonly logger?: Logger;
  /** Fetches the set as JSON; tests hand in their own. */
  readonly fetchKeySet?: (uri: string) => Promise<unknown>;
  /** Clock in milliseconds; tests hand in their own. */
  readonly now?: () => number;
}

/** A public key from the set and the kid it goes by, if it has one. */
interface NamedKey {
  readonly kid?: string;
  readonly key: KeyObject;
}

/** Loads the set once, so an unreachable issuer stops the start, and returns the lookup. */
export async function loadKeySet(options: KeySetOptions): Promise<KeyLookup> {
  const fetchKeySet = options.fetchKeySet ?? fetchJson;
  const now = options.now ?? Date.now;

  const load = async (): Promise<NamedKey[]> => {
    const keys = usableKeys(await fetchKeySet(options.uri), options.algorithm);
    if (keys.length === 0) {
      throw new Error(`no key in ${options.uri} fits ${options.algorithm}`);
    }
    return keys;
  };

  let keys = await load();
  let loadedAt = now();
  let triedAt = loadedAt;
  let pending: Promise<void> | undefined;

  // One load at a time; whoever asks meanwhile waits for the same one.
  const reload = (): Promise<void> => {
    pending ??= (async () => {
      triedAt = now();
      try {
        keys = await load();
        loadedAt = now();
      } catch (error) {
        // The keys known so far stay, a short outage of the issuer must not lock everyone out.
        options.logger?.warn({ err: error, uri: options.uri }, 'key set could not be reloaded');
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };

  return async (kid) => {
    // An unknown kid may be a new key, an old set may still hold a withdrawn one.
    const outdated = find(keys, kid) === undefined || now() - loadedAt >= MAX_AGE_MS;
    if (outdated && (pending !== undefined || now() - triedAt >= RELOAD_COOLDOWN_MS)) {
      await reload();
    }

    const key = find(keys, kid);
    if (key === undefined) {
      throw new Error(kid === undefined ? 'token names no key' : `no key with kid ${kid}`);
    }
    return key;
  };
}

/** The key a token names; without a kid only a set of exactly one key is unambiguous. */
function find(keys: readonly NamedKey[], kid: string | undefined): KeyObject | undefined {
  if (kid === undefined) {
    return keys.length === 1 ? keys[0]?.key : undefined;
  }
  return keys.find((named) => named.kid === kid)?.key;
}

/** The keys of a JWKS that can check the pinned algorithm; broken or foreign ones are skipped. */
function usableKeys(set: unknown, algorithm: TokenAlgorithm): NamedKey[] {
  const entries: unknown = isRecord(set) ? set['keys'] : undefined;
  if (!Array.isArray(entries)) {
    throw new Error('answer is no key set');
  }

  const keyType = algorithm.startsWith('ES') ? 'EC' : 'RSA';
  const keys: NamedKey[] = [];
  for (const jwk of entries) {
    // A key for encryption, for another algorithm or of another type cannot check this token.
    if (
      !isRecord(jwk) ||
      jwk['kty'] !== keyType ||
      (jwk['use'] !== undefined && jwk['use'] !== 'sig') ||
      (jwk['alg'] !== undefined && jwk['alg'] !== algorithm)
    ) {
      continue;
    }

    let key: KeyObject;
    try {
      key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
    } catch {
      continue;
    }
    keys.push(typeof jwk['kid'] === 'string' ? { kid: jwk['kid'], key } : { key });
  }
  return keys;
}

/** Fetches the set with a time limit; an answer other than 2xx counts as failed. */
async function fetchJson(uri: string): Promise<unknown> {
  // fetch only says "fetch failed", so the address goes into the message and the reason into cause.
  const response = await fetch(uri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(
    (cause: unknown) => {
      throw new Error(`${uri} is unreachable`, { cause });
    },
  );
  if (!response.ok) {
    throw new Error(`${uri} answered ${response.status}`);
  }
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
