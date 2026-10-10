/** The routes of CK as one thin function each, grouped as CK groups them. */

import type { CollabKitApi } from './api.ts';
import { callRoute, fetchRoute, type CallOptions, type Query } from './http.ts';

/** Every route but the session, which is not one. */
export type Routes = Omit<CollabKitApi, 'open'>;

/** A key as one path segment, so an actor key with a slash stays one. */
const segment = (key: string): string => encodeURIComponent(key);

/** One function per route; every call asks for a token, so a renewed one counts at once. */
export function createRoutes(baseUrl: string, getToken: () => string | Promise<string>): Routes {
  const call = async <Answer>(method: string, path: string, options?: CallOptions) =>
    callRoute<Answer>(baseUrl, await getToken(), method, path, options);
  // Reading and deleting carry their fields in the query, writing in the body.
  const read = <Answer>(path: string, query: Query = {}) => call<Answer>('GET', path, { query });
  const remove = <Answer>(path: string, query: Query = {}) =>
    call<Answer>('DELETE', path, { query });
  const write = <Answer>(method: string, path: string, body: unknown) =>
    call<Answer>(method, path, { body });

  return {
    rooms: {
      create: (room) => write('POST', '/rooms', room),
      get: (id) => read(`/rooms/${segment(id)}`),
      update: (id, change) => write('PATCH', `/rooms/${segment(id)}`, change),
      remove: (id, options = {}) => remove(`/rooms/${segment(id)}`, { ...options }),
      addReference: (id, reference) => write('POST', `/rooms/${segment(id)}/references`, reference),
      removeReference: (id, reference) =>
        remove(`/rooms/${segment(id)}/references`, { ...reference }),
      events: (id, query = {}) => read(`/rooms/${segment(id)}/events`, { ...query }),
      activity: (id) => read(`/rooms/${segment(id)}/activity`),
    },
    groups: {
      create: (group) => write('POST', '/groups', group),
      list: () => read('/groups'),
      get: (id) => read(`/groups/${segment(id)}`),
      update: (id, change) => write('PATCH', `/groups/${segment(id)}`, change),
      remove: (id, options = {}) => remove(`/groups/${segment(id)}`, { ...options }),
      addMember: (id, actorId) => write('POST', `/groups/${segment(id)}/members`, { actorId }),
      removeMember: (id, actorId) => remove(`/groups/${segment(id)}/members/${segment(actorId)}`),
    },
    grants: {
      set: (grant) => write('PUT', '/grants', grant),
      // The place goes flat into the query, as scopeKind and scopeId.
      remove: ({ groupId, scope, reason }) =>
        remove('/grants', { groupId, scopeKind: scope?.kind, scopeId: scope?.id, reason }),
      list: ({ groupId, scope } = {}) =>
        read('/grants', { groupId, scopeKind: scope?.kind, scopeId: scope?.id }),
    },
    workpieces: {
      create: (workpiece) => write('POST', '/workpieces', workpiece),
      list: () => read('/workpieces'),
      get: (id) => read(`/workpieces/${segment(id)}`),
      updates: (id, query = {}) => read(`/workpieces/${segment(id)}/updates`, { ...query }),
      activity: (id) => read(`/workpieces/${segment(id)}/activity`),
      state: async (id, at) => {
        const response = await fetchRoute(
          baseUrl,
          await getToken(),
          'GET',
          `/workpieces/${segment(id)}/state`,
          { query: { at } },
        );
        const state = new Uint8Array(await response.arrayBuffer());
        // Which change the state reaches, so the tool knows what it holds.
        const upToUpdateId = response.headers.get('X-Up-To-Update-Id');
        return upToUpdateId === null ? { state } : { state, upToUpdateId };
      },
      checkpoint: (id, checkpoint = {}) =>
        write('POST', `/workpieces/${segment(id)}/checkpoints`, checkpoint),
      fork: (id, fork) => write('POST', `/workpieces/${segment(id)}/forks`, fork),
      merge: (id, merge) => write('POST', `/workpieces/${segment(id)}/merges`, merge),
    },
    comments: {
      create: (comment) => write('POST', '/comments', comment),
      get: (id) => read(`/comments/${segment(id)}`),
      list: (query) => read('/comments', { ...query }),
      update: (id, change) => write('PATCH', `/comments/${segment(id)}`, change),
      remove: (id, options = {}) => remove(`/comments/${segment(id)}`, { ...options }),
    },
    tasks: {
      create: (task) => write('POST', '/tasks', task),
      get: (id) => read(`/tasks/${segment(id)}`),
      list: (query) => read('/tasks', { ...query }),
      update: (id, change) => write('PATCH', `/tasks/${segment(id)}`, change),
      addAssignee: (id, assignee, options = {}) =>
        write('POST', `/tasks/${segment(id)}/assignees`, { ...assignee, ...options }),
      removeAssignee: (id, assignee, options = {}) =>
        remove(`/tasks/${segment(id)}/assignees`, { ...assignee, ...options }),
    },
    events: {
      create: (event) => write('POST', '/events', event),
      list: (query) => read('/events', { ...query }),
    },
    actors: {
      names: (actorIds) => read('/actors', { ids: actorIds.join(',') }),
    },
    me: {
      who: () => read('/me'),
      rights: (target) => read('/me/rights', { kind: target?.kind, id: target?.id }),
      rooms: () => read('/me/rooms'),
      groups: () => read('/me/groups'),
      tasks: (query = {}) => read('/me/tasks', { ...query }),
      events: (query = {}) => read('/me/events', { ...query }),
    },
  };
}
