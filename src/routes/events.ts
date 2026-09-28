import { Router } from 'express';
import type { Db } from 'mongodb';

import { WHOLE, type Anchor, type AnchorQuery } from '../model/anchor.ts';
import { maySee } from '../auth/access.ts';
import {
  readEvents,
  readEventsSince,
  recordEvent,
  SERVICE_KINDS,
} from '../db/collections/events.ts';
import { asActorId, asCount, asObject, asObjectId, asReferenceId, asText } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, unusableField } from './http.ts';

/** Traces and marks: forwards with since to follow along, backwards without it to look back. */
export function eventRoutes(db: Db): Router {
  const routes = Router();

  routes.get('/events', async (request, response) => {
    const anchor = anchorQueryOf(request.query);
    const since = asObjectId(request.query['since']);
    const before = asObjectId(request.query['before']);
    const kind = asText(request.query['kind']);
    const createdBy = asActorId(request.query['createdBy']);
    const limit = asCount(request.query['limit']);
    const scope = request.query['scope'] === 'whole' ? 'whole' : undefined;

    if (anchor === undefined) {
      return fail(response, 400, 'anchorKind and anchorId are needed');
    }
    // Dropped, a filter would widen the answer unnoticed, a cut turn a stream into a history.
    const unusable = unusableField(request.query, { since, before, kind, createdBy, limit, scope });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }
    if (!(await maySee(db, actorOf(request), anchor))) {
      return fail(response, 404, 'unknown anchor');
    }

    const query = { anchor, ...defined({ kind, createdBy, before, limit }) };

    // With a cut a stream, read forwards; without one a history, read backwards.
    response.json(
      since === undefined
        ? await readEvents(db, query)
        : await readEventsSince(db, { ...query, since }),
    );
  });

  /** What the tool reports itself, a visit or a reading mark; the kind is free. */
  routes.post('/events', async (request, response) => {
    const body = bodyOf(request);
    const kind = asText(body['kind']);
    const anchor = anchorOf(asObject(body['anchor']));
    const at = asObjectId(body['at']);
    const label = asText(body['label']);
    const reason = asText(body['reason']);
    const detail = asObject(body['detail']);

    if (kind === undefined) {
      return fail(response, 400, 'kind is missing');
    }
    // Otherwise a report could pass for the proof of a change that never happened.
    if (SERVICE_KINDS.has(kind)) {
      return fail(response, 400, 'kind is written by the service alone');
    }
    if (anchor === undefined) {
      return fail(response, 400, 'anchor with kind and id is needed');
    }
    const unusable = unusableField(body, { at, label, reason, detail });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }
    if (!(await maySee(db, actorOf(request), anchor))) {
      return fail(response, 404, 'unknown anchor');
    }

    response.status(201).json(
      await recordEvent(db, {
        kind,
        createdBy: actorOf(request).actorId,
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
  const id = asReferenceId(raw?.['id']);

  if (raw === undefined || kind === undefined || id === undefined) {
    return undefined;
  }

  return { kind, id, ...defined({ unit: raw['unit'] }) };
}

/** The anchor from a flat query: no unit is all of it, scope=whole the thing, a unit one place. */
function anchorQueryOf(query: Record<string, unknown>): AnchorQuery | undefined {
  const kind = asText(query['anchorKind']);
  const id = asReferenceId(query['anchorId']);

  if (kind === undefined || id === undefined) {
    return undefined;
  }

  const unit = query['unit'];

  if (unit !== undefined) {
    return { kind, id, unit };
  }
  return asText(query['scope']) === 'whole' ? { kind, id, unit: WHOLE } : { kind, id };
}
