import { Router } from 'express';
import type { Db } from 'mongodb';

import { may, mayHandOn, maySeeGroup, placeExists, rightsAt } from '../auth/access.ts';
import { findGrant, grantsAt, grantsOf, removeGrant, setGrant } from '../db/collections/grants.ts';
import { findGroup } from '../db/collections/groups.ts';
import { withNames } from '../db/names.ts';
import type { Actor } from '../model/actor.ts';
import type { Reference } from '../model/anchor.ts';
import { RIGHTS } from '../model/right.ts';
import {
  asObjectId,
  asReference,
  asRights,
  asText,
  REFERENCE_RULE,
  RIGHTS_RULE,
} from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, unusableField } from './http.ts';

/** Who holds which rights where: the tool decides who gets them, the service that none is taken. */
export function grantRoutes(db: Db, recheckAccess: () => Promise<void>): Router {
  const routes = Router();

  /** Sets what a group may do at a place, or everywhere without one, replacing what it had. */
  routes.put('/grants', async (request, response) => {
    const body = bodyOf(request);
    const groupId = asObjectId(body['groupId']);
    const scope = asReference(body['scope']);
    const rights = asRights(body['rights']);
    const reason = asText(body['reason']);

    if (groupId === undefined) {
      return fail(response, 400, 'groupId is missing');
    }
    if (body['scope'] !== undefined && scope === undefined) {
      return fail(response, 400, REFERENCE_RULE);
    }
    if (rights === undefined) {
      return fail(response, 400, RIGHTS_RULE);
    }
    const unusable = unusableField(body, { reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    // The group only receives, so it has to exist; its members stay out of the answer.
    const actor = actorOf(request);
    if ((await findGroup(db, groupId)) === null) {
      return fail(response, 404, 'unknown group');
    }
    // An unknown and an unseen place answer alike, so nobody learns by trying what exists.
    if (scope !== undefined && !(await seesPlace(db, actor, scope))) {
      return fail(response, 404, 'unknown place');
    }
    if (!(await mayHandOn(db, actor, scope, rights))) {
      return fail(response, 403, 'not allowed to hand these rights on here');
    }

    const changed = await setGrant(db, {
      groupId,
      rights,
      setBy: actor.actorId,
      ...defined({ scope, reason }),
    });
    // Replacing may take rights away, so open connections are asked again.
    if (changed) {
      await recheckAccess();
    }
    response.json(await withNames(db, await findGrant(db, groupId, scope)));
  });

  // In the query and not the body: a body on DELETE may get lost on the way.
  routes.delete('/grants', async (request, response) => {
    const groupId = asObjectId(request.query['groupId']);
    const scope = scopeIn(request.query);
    const reason = asText(request.query['reason']);

    if (groupId === undefined) {
      return fail(response, 400, 'groupId is missing');
    }
    if (scope === null) {
      return fail(response, 400, REFERENCE_RULE);
    }
    const unusable = unusableField(request.query, { reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    // Taking away hands nothing on, so managing the place is enough; it may be gone by now.
    const actor = actorOf(request);
    if (!(await may(db, actor, 'manage', scope))) {
      return fail(response, 403, 'not allowed to take rights away here');
    }

    const removed = await removeGrant(db, {
      groupId,
      removedBy: actor.actorId,
      ...defined({ scope, reason }),
    });
    // Without the grant, open connections it carried would go on as before.
    if (removed) {
      await recheckAccess();
    }
    response.json({ removed });
  });

  /** The grants at a place, or everywhere without one, or those of a group; reading is managing. */
  routes.get('/grants', async (request, response) => {
    const groupId = asObjectId(request.query['groupId']);
    const scope = scopeIn(request.query);

    if (request.query['groupId'] !== undefined && groupId === undefined) {
      return fail(response, 400, 'groupId is unusable');
    }
    if (scope === null) {
      return fail(response, 400, REFERENCE_RULE);
    }
    if (groupId !== undefined && scope !== undefined) {
      return fail(response, 400, 'either groupId or a place, not both');
    }

    // A group is asked about at itself, a place at that place.
    const actor = actorOf(request);
    const at = groupId === undefined ? scope : { kind: 'group' as const, id: groupId };
    if (!(await may(db, actor, 'manage', at))) {
      return fail(response, 403, 'not allowed to read these grants');
    }

    const grants = groupId === undefined ? await grantsAt(db, scope) : await grantsOf(db, groupId);
    response.json(await withNames(db, grants));
  });

  /** What this token may do at a thing, or everywhere without one, so a tool can shape its view. */
  routes.get('/me/rights', async (request, response) => {
    const { kind, id } = request.query;
    const target = asReference({ kind, id });

    if ((kind !== undefined || id !== undefined) && target === undefined) {
      return fail(response, 400, REFERENCE_RULE);
    }

    const held = await rightsAt(db, actorOf(request), target);
    response.json(RIGHTS.filter((right) => held.has(right)));
  });

  return routes;
}

/** scopeKind and scopeId from a query: a place, undefined for none, null when only half fits. */
function scopeIn(query: Record<string, unknown>): Reference | undefined | null {
  const { scopeKind, scopeId } = query;

  if (scopeKind === undefined && scopeId === undefined) {
    return undefined;
  }
  return asReference({ kind: scopeKind, id: scopeId }) ?? null;
}

/** A place is there and in view; a group by its own rule, everything else by see. */
async function seesPlace(db: Db, actor: Actor, scope: Reference): Promise<boolean> {
  if (scope.kind === 'group') {
    const group = await findGroup(db, scope.id);
    return group !== null && maySeeGroup(db, actor, group);
  }
  return (await placeExists(db, scope)) && may(db, actor, 'see', scope);
}
