import { Router } from 'express';
import type { Db } from 'mongodb';

import { mayChange, maySeeGroup } from '../auth/access.ts';
import {
  addMember,
  createGroup,
  findGroup,
  groupsOf,
  removeMember,
  setGroupSettings,
} from '../db/collections/groups.ts';
import { asObject, asText } from '../input.ts';
import { defined } from '../optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId } from './http.ts';

/**
 * A group is a set of actors and nothing else. What it stands for lives in settings,
 * which the service stores and never reads: the roles are the business of the tool.
 */
export function groupRoutes(db: Db): Router {
  const routes = Router();

  routes.param('id', requireId('group'));

  const changing = guard(
    (actor, id) => mayChange(db, actor, 'group', id),
    403,
    'not allowed to change this group',
  );

  routes.post('/groups', async (request, response) => {
    const body = bodyOf(request);
    const name = asText(body['name']);

    if (name === undefined) {
      return fail(response, 400, 'name is missing');
    }

    const members = asMembers(body['members']);
    if (members === undefined) {
      return fail(response, 400, 'members must be a list of actor keys');
    }

    const settings = asObject(body['settings']);
    const group = await createGroup(db, {
      name,
      createdBy: actorOf(request).actorId,
      members,
      ...defined({ settings }),
    });

    response.status(201).json(group);
  });

  routes.get('/groups/:id', async (request, response) => {
    const group = await findGroup(db, idOf(request));

    if (group === null || !maySeeGroup(actorOf(request), group)) {
      return fail(response, 404, 'unknown group');
    }

    response.json(group);
  });

  routes.patch('/groups/:id', changing, async (request, response) => {
    const settings = asObject(bodyOf(request)['settings']);

    if (settings === undefined) {
      return fail(response, 400, 'settings must be an object');
    }

    const id = idOf(request);
    await setGroupSettings(db, id, settings);
    response.json(await findGroup(db, id));
  });

  routes.post('/groups/:id/members', changing, async (request, response) => {
    const actorId = asText(bodyOf(request)['actorId']);

    if (actorId === undefined) {
      return fail(response, 400, 'actorId is missing');
    }

    const id = idOf(request);
    const added = await addMember(db, id, { actorId, addedBy: actorOf(request).actorId });
    response.status(added ? 201 : 200).json(await findGroup(db, id));
  });

  routes.delete('/groups/:id/members/:actorId', changing, async (request, response) => {
    const actorId = asText(request.params['actorId']);

    if (actorId === undefined) {
      return fail(response, 400, 'actorId is missing');
    }

    const id = idOf(request);
    await removeMember(db, id, actorId);
    response.json(await findGroup(db, id));
  });

  /** Where a client starts: the groups this token is in, and from there the rooms. */
  routes.get('/me/groups', async (request, response) => {
    response.json(await groupsOf(db, actorOf(request).actorId));
  });

  return routes;
}

/** Absent means none. A list has to hold actor keys, anything else is a mistake. */
function asMembers(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const members = raw.map((entry: unknown) => asText(entry));
  return members.every((member) => member !== undefined) ? (members as string[]) : undefined;
}
