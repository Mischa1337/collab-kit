import { Router } from 'express';
import type { Db } from 'mongodb';

import {
  assigneeSees,
  assigneesFor,
  mayAssignTask,
  mayAssignTo,
  mayCreateAt,
  maySee,
  maySetTaskState,
} from '../auth/access.ts';
import { aboutOf, aboutOfTask } from '../db/about.ts';
import {
  addAssignee,
  createTask,
  findTask,
  readTasks,
  removeAssignee,
  setTaskState,
  type TaskQuery,
} from '../db/collections/tasks.ts';
import {
  ANCHOR_QUERY_RULE,
  ASSIGNEE_RULE,
  asAnchor,
  asAnchorQuery,
  asAssignee,
  asAssignees,
  asNumber,
  asObject,
  asObjectId,
  asParentId,
  asText,
} from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** Task, review, revision and approval alike: something to be done, by someone, with a state. */
export function taskRoutes(db: Db, decisions: readonly string[]): Router {
  const routes = Router();

  routes.param('id', requireId('task'));

  // Seen by its assignees and whoever sees it, its anchor or parent; 404 hides it too.
  const seeing = guard((actor, id) => maySee(db, actor, { kind: 'task', id }), 404, 'unknown task');
  // Behind seeing, so 403 tells only whoever already sees the task.
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
    const assignees = asAssignees(body['assignees']);
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
    if (body['assignees'] !== undefined && assignees === undefined) {
      return fail(response, 400, `assignees must be a list; ${ASSIGNEE_RULE}`);
    }
    const unusable = unusableField(body, { anchor, parentId, order, detail });
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
    // Planning takes plan where it hangs, or everywhere at nothing; a first decision, decide too.
    const places = [
      ...(anchor === undefined ? [] : [anchor]),
      ...(parentId === undefined ? [] : [{ kind: 'task' as const, id: parentId }]),
    ];
    if (!(await mayCreateAt(db, actor, 'plan', places))) {
      return fail(response, 403, 'not allowed to plan here');
    }
    if (decisions.includes(state) && !(await mayCreateAt(db, actor, 'decide', places))) {
      return fail(response, 403, 'not allowed to decide here');
    }
    const given = assignees ?? [];
    const assignable = await Promise.all(given.map((assignee) => mayAssignTo(db, actor, assignee)));
    if (!assignable.every(Boolean)) {
      return fail(response, 404, 'unknown assignee');
    }
    const seen = await Promise.all(given.map((assignee) => assigneeSees(db, assignee, anchor)));
    if (!seen.every(Boolean)) {
      return fail(response, 409, 'an assigned group may not see what the task is about');
    }

    // Looked up here and never read from the body, so no task lands in another room's stream.
    const about = await aboutOfTask(db, { anchor, parentId });
    response.status(201).json(
      await createTask(db, {
        kind,
        title,
        state,
        createdBy: actor.actorId,
        ...defined({ anchor, parentId, assignees, order, detail, about }),
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
  routes.patch('/tasks/:id', seeing, async (request, response) => {
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
    // Asked only now, as the state decides which right it takes; seeing came first, so 404 first.
    const actor = actorOf(request);
    const id = idOf(request);
    const task = await findTask(db, id);
    if (task === null || !(await maySetTaskState(db, actor, task, state, decisions))) {
      return fail(response, 403, 'not allowed to change this task');
    }

    const about = await aboutOfTask(db, task);
    response.json(
      await setTaskState(db, id, {
        state,
        changedBy: actor.actorId,
        ...defined({ reason, about }),
      }),
    );
  });

  /** Gives the task to one more person or group; who gave it to whom and why land in its events. */
  routes.post('/tasks/:id/assignees', seeing, assigning, async (request, response) => {
    const body = bodyOf(request);
    const assignee = asAssignee(body);
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
    // Checked only now, when it is given; a grant taken later leaves it given.
    const id = idOf(request);
    const task = await findTask(db, id);
    if (!(await assigneeSees(db, assignee, task?.anchor))) {
      return fail(response, 409, 'the group may not see what the task is about');
    }

    const about = await aboutOf(db, { kind: 'task', id });
    const added = await addAssignee(db, id, {
      assignee,
      changedBy: actor.actorId,
      ...defined({ reason, about }),
    });

    // 200 if it was already there: giving it twice is no error, it just changes nothing.
    response.status(added ? 201 : 200).json(await findTask(db, id));
  });

  // In the query and not the body: a body on DELETE may get lost on the way.
  routes.delete('/tasks/:id/assignees', seeing, assigning, async (request, response) => {
    const assignee = asAssignee(request.query);
    const reason = asText(request.query['reason']);

    if (assignee === undefined) {
      return fail(response, 400, ASSIGNEE_RULE);
    }
    const unusable = unusableField(request.query, { reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    // No mayAssignTo, as in rooms: taking an entry off hands nothing out.
    const id = idOf(request);
    const about = await aboutOf(db, { kind: 'task', id });
    await removeAssignee(db, id, {
      assignee,
      changedBy: actorOf(request).actorId,
      ...defined({ reason, about }),
    });
    response.json(await findTask(db, id));
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
