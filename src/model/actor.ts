/** A person as the docking tool's token names them: an opaque key and a name to show. */
export interface Actor {
  readonly actorId: string;
  readonly label?: string;
  /** Named by the top claim of the instance, so every right holds everywhere; never stored. */
  readonly top?: true;
  /** Seconds since 1970 until the token is taken, tolerance included; left out, it never runs out. */
  readonly expiresAt?: number;
}
