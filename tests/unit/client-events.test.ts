import { describe, expect, it } from 'vitest';

import { CollabKitError, type CollabEvent } from '../../client/src/api.ts';
import { eventsInRooms } from '../../client/src/events.ts';
import type { Routes } from '../../client/src/rest.ts';

/** An event with this id, the rest as any would have it. */
const event = (id: string): CollabEvent => ({
  _id: id.padStart(24, '0'),
  kind: 'visit',
  createdBy: 'dave',
  anchor: { kind: 'workpiece', id: 'w'.padStart(24, '0') },
  createdAt: '2026-10-16T00:00:00.000Z',
});

/** Routes that know these rooms; a room given an error answers with it. */
function routesWith(rooms: Record<string, CollabEvent[] | Error>): Routes {
  return {
    me: { rooms: async () => Object.keys(rooms).map((id) => ({ _id: id })) },
    rooms: {
      events: async (id: string) => {
        const answer = rooms[id];
        if (answer instanceof Error) {
          throw answer;
        }
        return answer ?? [];
      },
    },
  } as unknown as Routes;
}

describe('the events of all rooms', () => {
  it('leaves out a room gone since /me/rooms', async () => {
    const routes = routesWith({ a: [event('1')], b: new CollabKitError(404, 'unknown room') });
    expect(await eventsInRooms(routes)).toEqual([event('1')]);
  });

  it('fails on any other refusal', async () => {
    const routes = routesWith({ a: [event('1')], b: new CollabKitError(500, 'broken') });
    await expect(eventsInRooms(routes)).rejects.toMatchObject({ status: 500 });
  });
});
