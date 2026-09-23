/**
 * Everything the service learns about a person: an opaque key and a name to show.
 * It arrives with the token of the docking tool; the service never issues one itself.
 */
export interface Actor {
  readonly actorId: string;
  readonly label?: string;
}
