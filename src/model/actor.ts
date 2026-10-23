/** A person as the docking tool's token names them: an opaque key and a name to show. */
export interface Actor {
  readonly actorId: string;
  readonly label?: string;
  /** Named by the top claim of the instance, so every right holds everywhere; never stored. */
  readonly top?: true;
  /** Seconds since 1970 until the token is taken, tolerance included; left out, it never runs out. */
  readonly expiresAt?: number;
}

/** What every pseudonym begins with; a key that does is never taken as a person's. */
export const PSEUDONYM_PREFIX = 'anon-';

/** Whether a key looks like one the service makes up for a person writing anonymously. */
export function isPseudonym(key: string): boolean {
  return key.startsWith(PSEUDONYM_PREFIX);
}
