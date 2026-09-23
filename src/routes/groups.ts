import { Router } from 'express';
import type { Db } from 'mongodb';

import { mayChange } from '../auth/access.ts';
import {
  addMember,
  createGroup,
  findGroup,
  groupsOf,
  removeMember,
  setGroupSettings,
} from '../db/collections/groups.ts';
import { actorOf, asObject, asObjectId, asText, bodyOf, fail } from './http.ts';

/**
 * A group is a set of actors and nothing else. What it stands for lives in settings,
 * which the service stores and never reads: the roles are the business of the tool.
 */
export function groupRoutes(db: Db): Router {
  const routes = Router();

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
      ...(settings === undefined ? {} : { settings }),
    });

    response.status(201).json(group);
  });

  routes.get('/groups/:id', async (request, response) => {
    const id = asObjectId(request.params['id']);

    if (id === undefined) {
      return fail(response, 400, 'malformed group key');
    }

    const group = await findGroup(db, id);
    const actorId = actorOf(request).actorId;

    // Seen by its members and by whoever created it, nobody else. Who is in a group
    // is exactly what that group opens.
    if (
      group === null ||
      (group.createdBy !== actorId && !group.members.some((member) => member.actorId === actorId))
    ) {
      return fail(response, 404, 'unknown group');
    }

    response.json(group);
  });

  routes.patch('/groups/:id', async (request, response) => {
    const id = asObjectId(request.params['id']);
    const settings = asObject(bodyOf(request)['settings']);

    if (id === undefined) {
      return fail(response, 400, 'malformed group key');
    }
    if (settings === undefined) {
      return fail(response, 400, 'settings must be an object');
    }
    if (!(await mayChange(db, actorOf(request), 'groups', id))) {
      return fail(response, 403, 'not allowed to change this group');
    }

    await setGroupSettings(db, id, settings);
    response.json(await findGroup(db, id));
  });

  routes.post('/groups/:id/members', async (request, response) => {
    const id = asObjectId(request.params['id']);
    const actorId = asText(bodyOf(request)['actorId']);

    if (id === undefined) {
      return fail(response, 400, 'malformed group key');
    }
    if (actorId === undefined) {
      return fail(response, 400, 'actorId is missing');
    }
    if (!(await mayChange(db, actorOf(request), 'groups', id))) {
      return fail(response, 403, 'not allowed to change this group');
    }

    const added = await addMember(db, id, { actorId, addedBy: actorOf(request).actorId });
    response.status(added ? 201 : 200).json(await findGroup(db, id));
  });

  routes.delete('/groups/:id/members/:actorId', async (request, response) => {
    const id = asObjectId(request.params['id']);
    const actorId = asText(request.params['actorId']);

    if (id === undefined) {
      return fail(response, 400, 'malformed group key');
    }
    if (actorId === undefined) {
      return fail(response, 400, 'actorId is missing');
    }
    if (!(await mayChange(db, actorOf(request), 'groups', id))) {
      return fail(response, 403, 'not allowed to change this group');
    }

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
