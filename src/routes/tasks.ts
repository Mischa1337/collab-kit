import { Router } from 'express';
import type { Db } from 'mongodb';

import {
  assigneesFor,
  mayAssignTask,
  mayAssignTo,
  maySee,
  maySetTaskState,
} from '../auth/access.ts';
import {
  assignTask,
  createTask,
  findTask,
  readTasks,
  setTaskState,
  type TaskQuery,
} from '../db/collections/tasks.ts';
import {
  ANCHOR_QUERY_RULE,
  ASSIGNEE_RULE,
  asAnchor,
  asAnchorQuery,
  asAssignee,
  asNumber,
  asObject,
  asObjectId,
  asParentId,
  asText,
} from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** Task, review, revision and approval alike: something to be done, by someone, with a state. */
export function taskRoutes(db: Db): Router {
  const routes = Router();

  routes.param('id', requireId('task'));

  // Seen by its creator, its assignee and whoever sees its anchor or parent; 404 hides it too.
  const seeing = guard((actor, id) => maySee(db, actor, { kind: 'task', id }), 404, 'unknown task');
  // Behind seeing, so 403 tells only whoever already sees the task; today all three agree.
  const moving = guard(
    (actor, id) => maySetTaskState(db, actor, id),
    403,
    'not allowed to change this task',
  );
  const assigning = guard(
    (actor, id) => mayAssignTask(db, actor, id),
    403,
    'not allowed to change this task',
  );

  routes.post('/tasks', async (request, response) => {
    const body = bodyOf(request);
    const kind = asText(body['kind']);
    const title = asText(body['title']);
    const state = asText(body['state']);
    const anchor = asAnchor(body['anchor']);
    const parentId = asObjectId(body['parentId']);
    const assignee = asAssignee(body['assignee']);
    const order = asNumber(body['order']);
    const detail = asObject(body['detail']);

    if (kind === undefined) {
      return fail(response, 400, 'kind is missing');
    }
    if (title === undefined) {
      return fail(response, 400, 'title is missing');
    }
    if (state === undefined) {
      return fail(response, 400, 'state is missing');
    }
    const unusable = unusableField(body, { anchor, parentId, assignee, order, detail });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    // As with comments, maySee finds nothing not yet written, so no chain closes into a
    // circle; here it matters twice, since maySeeTask follows both anchor and parent.
    const actor = actorOf(request);
    if (anchor !== undefined && !(await maySee(db, actor, anchor))) {
      return fail(response, 404, 'unknown anchor');
    }
    if (parentId !== undefined && !(await maySee(db, actor, { kind: 'task', id: parentId }))) {
      return fail(response, 404, 'unknown parent');
    }
    if (assignee !== undefined && !(await mayAssignTo(db, actor, assignee))) {
      return fail(response, 404, 'unknown assignee');
    }

    response.status(201).json(
      await createTask(db, {
        kind,
        title,
        state,
        createdBy: actor.actorId,
        ...defined({ anchor, parentId, assignee, order, detail }),
      }),
    );
  });

  routes.get('/tasks/:id', seeing, async (request, response) => {
    response.json(await findTask(db, idOf(request)));
  });

  /** Tasks at an anchor or under a parent; whoever sees that entry sees all that is found. */
  routes.get('/tasks', async (request, response) => {
    const { query } = request;
    const sent = (...names: string[]) => names.some((name) => query[name] !== undefined);
    const anchorSent = sent('anchorKind', 'anchorId', 'unit', 'scope');
    const anchor = anchorSent ? asAnchorQuery(query) : undefined;
    const parentId = asParentId(query['parentId']);
    const assigneeSent = sent('assigneeKind', 'assigneeId');
    const assignee = asAssignee({ kind: query['assigneeKind'], id: query['assigneeId'] });
    const kind = asText(query['kind']);
    const state = asText(query['state']);

    if (anchorSent && anchor === undefined) {
      return fail(response, 400, ANCHOR_QUERY_RULE);
    }
    if (assigneeSent && assignee === undefined) {
      return fail(response, 400, 'assigneeKind and assigneeId are unusable');
    }
    const unusable = unusableField(query, { parentId, kind, state });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    // Without an entry this would list every task of the service; parentId=none is no entry.
    const parent = parentId ?? undefined;
    if (anchor === undefined && parent === undefined) {
      return fail(response, 400, 'an anchor or a parentId is needed');
    }
    const actor = actorOf(request);
    if (anchor !== undefined && !(await maySee(db, actor, anchor))) {
      return fail(response, 404, 'unknown anchor');
    }
    if (parent !== undefined && !(await maySee(db, actor, { kind: 'task', id: parent }))) {
      return fail(response, 404, 'unknown parent');
    }

    const assignees: TaskQuery['assignees'] = assignee === undefined ? undefined : [assignee];
    response.json(await readTasks(db, defined({ anchor, parentId, assignees, kind, state })));
  });

  /** Moves the state; who moved it and why land in the events of the task. */
  routes.patch('/tasks/:id', seeing, moving, async (request, response) => {
    const body = bodyOf(request);
    const state = asText(body['state']);
    const reason = asText(body['reason']);

    if (state === undefined) {
      return fail(response, 400, 'state is missing');
    }
    const unusable = unusableField(body, { reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    response.json(
      await setTaskState(db, idOf(request), {
        state,
        changedBy: actorOf(request).actorId,
        ...defined({ reason }),
      }),
    );
  });

  /** Hands the task on; who gave it to whom and why land in the events of the task. */
  routes.put('/tasks/:id/assignee', seeing, assigning, async (request, response) => {
    const body = bodyOf(request);
    const assignee = asAssignee(body['assignee']);
    const reason = asText(body['reason']);

    if (assignee === undefined) {
      return fail(response, 400, ASSIGNEE_RULE);
    }
    const unusable = unusableField(body, { reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }
    const actor = actorOf(request);
    if (!(await mayAssignTo(db, actor, assignee))) {
      return fail(response, 404, 'unknown assignee');
    }

    response.json(
      await assignTask(db, idOf(request), {
        assignee,
        changedBy: actor.actorId,
        ...defined({ reason }),
      }),
    );
  });

  /** Where a client finds its work: tasks given to this token or to one of its groups. */
  routes.get('/me/tasks', async (request, response) => {
    const state = asText(request.query['state']);

    const unusable = unusableField(request.query, { state });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const assignees = await assigneesFor(db, actorOf(request));
    response.json(await readTasks(db, { assignees, ...defined({ state }) }));
  });

  return routes;
}
