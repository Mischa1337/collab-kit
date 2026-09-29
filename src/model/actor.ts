/** A person as the docking tool's token names them: an opaque key and a name to show. */
export interface Actor {
  readonly actorId: string;
  readonly label?: string;
}
