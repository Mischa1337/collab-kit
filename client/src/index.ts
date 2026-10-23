/** Entry of the client library, built into v1.js; what it offers is described in api.ts. */

import type * as Api from './api.ts';
import { eventsInRooms } from './events.ts';
import { callRoute } from './http.ts';
import { createRoutes } from './rest.ts';
import { openSession, type SessionContext } from './session.ts';

export { CollabKitError } from './api.ts';

/** Every pseudonym of CK begins so, and no person's key may. */
export const isPseudonym: typeof Api.isPseudonym = (key) => key.startsWith('anon-');

/** The library for one instance of CK; typed by api.ts, so v1.d.ts says what v1.js does. */
export const createCollabKitApi: typeof Api.createCollabKitApi = (options) => {
  // One address for both: the routes at it, the socket at the same with ws and /ws.
  const url = options.url.replace(/\/+$/, '');
  const getToken = () => options.getToken();
  const context: SessionContext = {
    socketUrl: `${url.replace(/^http/, 'ws')}/ws`,
    getToken,
    read: (token, path, query) => callRoute(url, token, 'GET', path, query ? { query } : {}),
  };

  const routes = createRoutes(url, getToken);

  return {
    ...routes,
    // Built on the routes, so the library asks CK nothing it could not ask itself.
    events: { ...routes.events, inRooms: (query) => eventsInRooms(routes, query) },
    open: (workpieceId, openOptions) => openSession(context, workpieceId, openOptions),
  };
};
