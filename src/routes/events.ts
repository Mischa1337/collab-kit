import { Router } from 'express';
import type { Db } from 'mongodb';

import { WHOLE, type Anchor, type AnchorQuery } from '../anchor.ts';
import { mayReach } from '../auth/access.ts';
import { readEvents, readEventsSince, recordEvent } from '../db/collections/events.ts';
import { asCount, asObject, asObjectId, asReferenceId, asText } from '../input.ts';
import { defined } from '../optional.ts';
import { actorOf, bodyOf, fail } from './http.ts';

/**
 * Traces and marks. Read forwards with `since` for polling, backwards without it for
 * a history, which is the difference between following along and looking back.
 */
export function eventRoutes(db: Db): Router {
  const routes = Router();

  routes.get('/events', async (request, response) => {
    const anchor = anchorQueryOf(request.query);

    if (anchor === undefined) {
      return fail(response, 400, 'anchorKind and anchorId are needed');
    }
    if (!(await mayReach(db, actorOf(request), anchor))) {
      return fail(response, 404, 'unknown anchor');
    }

    const since = asObjectId(request.query['since']);
    const kind = asText(request.query['kind']);
    const actorId = asText(request.query['actorId']);
    const limit = asCount(request.query['limit']);
    const query = { anchor, ...defined({ kind, actorId, limit }) };

    // With a cut it is a stream and reads forwards, without one it is a history and
    // reads backwards.
    response.json(
      since === undefined
        ? await readEvents(db, query)
        : await readEventsSince(db, { ...query, since }),
    );
  });

  /**
   * What the tool reports itself: that somebody visited, read up to here, or whatever
   * else it finds worth keeping. The kind is free, the actor comes from the token.
   */
  routes.post('/events', async (request, response) => {
    const body = bodyOf(request);
    const kind = asText(body['kind']);
    const anchor = anchorOf(asObject(body['anchor']));

    if (kind === undefined) {
      return fail(response, 400, 'kind is missing');
    }
    if (anchor === undefined) {
      return fail(response, 400, 'anchor with kind and id is needed');
    }
    if (!(await mayReach(db, actorOf(request), anchor))) {
      return fail(response, 404, 'unknown anchor');
    }

    const at = asObjectId(body['at']);
    const label = asText(body['label']);
    const reason = asText(body['reason']);
    const detail = asObject(body['detail']);

    response.status(201).json(
      await recordEvent(db, {
        kind,
        actorId: actorOf(request).actorId,
        anchor,
        ...defined({ at, label, reason, detail }),
      }),
    );
  });

  return routes;
}

/** The anchor as it arrives in a body: kind and id required, unit optional. */
function anchorOf(raw: Record<string, unknown> | undefined): Anchor | undefined {
  const kind = asText(raw?.['kind']);

  if (raw === undefined || kind === undefined || raw['id'] === undefined) {
    return undefined;
  }

  return { kind, id: asReferenceId(raw['id']), ...defined({ unit: raw['unit'] }) };
}

/**
 * The anchor as it arrives in a query, flat so it survives any query parser. Leaving
 * the unit out asks about the thing and everything in it, scope=whole about the thing
 * alone, and a unit about that one place.
 */
function anchorQueryOf(query: Record<string, unknown>): AnchorQuery | undefined {
  const kind = asText(query['anchorKind']);

  if (kind === undefined || query['anchorId'] === undefined) {
    return undefined;
  }

  const id = asReferenceId(query['anchorId']);
  const unit = query['unit'];

  if (unit !== undefined) {
    return { kind, id, unit };
  }
  return asText(query['scope']) === 'whole' ? { kind, id, unit: WHOLE } : { kind, id };
}
