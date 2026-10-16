/** Events across every room the token sees, built from the routes alone. */

import { CollabKitError, type CollabEvent, type Named, type RoomEventQuery } from './api.ts';
import type { Routes } from './rest.ts';

/** The streams of all visible rooms as one: each event once, oldest first, cut at limit. */
export async function eventsInRooms(
  routes: Routes,
  query: RoomEventQuery = {},
): Promise<Named<CollabEvent>[]> {
  const rooms = await routes.me.rooms();
  // Asked all at once; a room gone since leaves nothing instead of failing the rest.
  const streams = await Promise.all(
    rooms.map((room) => routes.rooms.events(room._id, query).catch(nothingIfGone)),
  );
  // A workpiece in two rooms brings its events twice, so each counts once.
  const byId = new Map(streams.flat().map((event) => [event._id, event]));
  // Ids grow with time and are of one length, so comparing them as text keeps the order.
  const merged = [...byId.values()].toSorted((one, other) => (one._id < other._id ? -1 : 1));
  // Each room gave its first limit, so the first limit of all lie among them.
  return query.limit === undefined ? merged : merged.slice(0, query.limit);
}

/** A room deleted or no longer seen after /me/rooms answers 404; anything else still fails. */
function nothingIfGone(error: unknown): Named<CollabEvent>[] {
  if (error instanceof CollabKitError && error.status === 404) {
    return [];
  }
  throw error;
}
