/** Who is at the workpiece: the own awareness entry, and all entries grouped by person. */

import type { Awareness } from 'y-protocols/awareness';

import type { Me, Person, Presence, PresenceClient } from './api.ts';

/** Writes who this is into the own entry for the own view; CK sets it from the token for the others. */
export function announce(awareness: Awareness, me: Me): void {
  awareness.setLocalStateField(
    'person',
    me.label === undefined ? { id: me.actorId } : { id: me.actorId, name: me.label },
  );
}

/** The presence of a session; awareness and self are asked at every call, as both may change. */
export function presenceOf(
  awareness: () => Awareness,
  self: () => string | undefined,
  listen: (listener: () => void) => () => void,
): Presence {
  return {
    set: (fields) => {
      const own = awareness().getLocalState() ?? {};
      // person stays what GET /me said, whatever the fields bring.
      awareness().setLocalState({ ...own, ...fields, person: own['person'] });
    },
    people: () => peopleIn(awareness().getStates(), self()),
    onChange: listen,
  };
}

/** The awareness entries by person; an entry without one is a session not yet in. */
function peopleIn(
  states: Map<number, Record<string, unknown>>,
  self: string | undefined,
): Person[] {
  const people = new Map<string, Person & { clients: PresenceClient[] }>();

  for (const [clientId, state] of states) {
    const person = personIn(state['person']);
    if (person === undefined) {
      continue;
    }
    const entry = people.get(person.id) ?? { ...person, self: person.id === self, clients: [] };
    entry.clients.push({ clientId, state });
    people.set(person.id, entry);
  }
  return [...people.values()];
}

/** The person an entry names, if it names one the way announce writes it. */
function personIn(raw: unknown): { id: string; name?: string } | undefined {
  if (typeof raw !== 'object' || raw === null || !('id' in raw) || typeof raw.id !== 'string') {
    return undefined;
  }
  return 'name' in raw && typeof raw.name === 'string'
    ? { id: raw.id, name: raw.name }
    : { id: raw.id };
}
