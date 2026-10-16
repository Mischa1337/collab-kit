import { Router } from 'express';
import type { Db } from 'mongodb';

import { maySee } from '../auth/access.ts';
import { aboutOf } from '../db/about.ts';
import {
  readEvents,
  readEventsSince,
  recordEvent,
  SERVICE_KINDS,
  type EventQuery,
  type EventRecord,
} from '../db/collections/events.ts';
import { eventKeysOf, withNames } from '../db/names.ts';
import type { Actor } from '../model/actor.ts';
import {
  ANCHOR_QUERY_RULE,
  ANCHOR_RULE,
  asActorId,
  asAnchor,
  asAnchorQuery,
  asCount,
  asObject,
  asObjectId,
  asText,
} from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, unusableField } from './http.ts';

/** Traces and marks: forwards with since to follow along, backwards without it to look back. */
export function eventRoutes(db: Db): Router {
  const routes = Router();

  routes.get('/events', async (request, response) => {
    const anchor = asAnchorQuery(request.query);
    const since = asObjectId(request.query['since']);
    const before = asObjectId(request.query['before']);
    const kind = asText(request.query['kind']);
    const createdBy = asActorId(request.query['createdBy']);
    const limit = asCount(request.query['limit']);

    if (anchor === undefined) {
      return fail(response, 400, ANCHOR_QUERY_RULE);
    }
    // Dropped, a filter would widen the answer unnoticed, a cut turn a stream into a history.
    const unusable = unusableField(request.query, { since, before, kind, createdBy, limit });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }
    if (!(await maySee(db, actorOf(request), anchor))) {
      return fail(response, 404, 'unknown anchor');
    }

    const query = { anchor, ...defined({ kind, createdBy, before, limit }) };

    // With a cut a stream, read forwards; without one a history, read backwards.
    const events =
      since === undefined
        ? await readEvents(db, query)
        : await readEventsSince(db, { ...query, since });
    response.json(await withNames(db, events, eventKeysOf));
  });

  /** What concerns this token, such as its work somebody removed, wherever it may still see. */
  routes.get('/me/events', async (request, response) => {
    const since = asObjectId(request.query['since']);
    const before = asObjectId(request.query['before']);
    const kind = asText(request.query['kind']);
    const limit = asCount(request.query['limit']);

    const unusable = unusableField(request.query, { since, before, kind, limit });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const actor = actorOf(request);
    const events = await readVisible(db, actor, {
      affects: actor.actorId,
      ...defined({ since, before, kind, limit }),
    });
    response.json(await withNames(db, events, eventKeysOf));
  });

  /** What the tool reports itself, a visit or a reading mark; the kind is free. */
  routes.post('/events', async (request, response) => {
    const body = bodyOf(request);
    const kind = asText(body['kind']);
    const anchor = asAnchor(body['anchor']);
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
      return fail(response, 400, ANCHOR_RULE);
    }
    const unusable = unusableField(body, { at, label, reason, detail });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }
    const actor = actorOf(request);
    if (!(await maySee(db, actor, anchor))) {
      return fail(response, 404, 'unknown anchor');
    }

    // Only the service says what a comment or task is about, so no report lands in another room.
    const about =
      anchor.kind === 'comment' || anchor.kind === 'task' ? await aboutOf(db, anchor) : undefined;
    const event = await recordEvent(db, {
      kind,
      createdBy: actor.actorId,
      anchor,
      ...defined({ about, at, label, reason, detail }),
    });
    response.status(201).json(await withNames(db, event, eventKeysOf));
  });

  return routes;
}

/** Reads on until the page is full, so events at places no longer seen never end it early. */
async function readVisible(db: Db, actor: Actor, query: EventQuery): Promise<EventRecord[]> {
  // With a cut a stream, read forwards; without one a history, read backwards.
  const forwards = query.since !== undefined;
  // Asked once per anchor, however many events hang on it.
  const seen = new Map<string, Promise<boolean>>();
  const visible: EventRecord[] = [];
  let next = query;

  /* eslint-disable no-await-in-loop */
  for (;;) {
    const page = forwards ? await readEventsSince(db, next) : await readEvents(db, next);

    for (const event of page) {
      const key = `${event.anchor.kind} ${event.anchor.id.toHexString()}`;
      if (!seen.has(key)) {
        seen.set(key, maySee(db, actor, event.anchor));
      }
      if (await seen.get(key)) {
        visible.push(event);
      }
      if (visible.length === query.limit) {
        return visible;
      }
    }

    // Without a limit everything was read, and a short page means nothing is left.
    const last = page.at(-1);
    if (query.limit === undefined || page.length < query.limit || last === undefined) {
      return visible;
    }
    next = forwards ? { ...next, since: last._id } : { ...next, before: last._id };
  }
  /* eslint-enable no-await-in-loop */
}
