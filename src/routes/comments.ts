import { Router } from 'express';
import type { Db } from 'mongodb';

import { mayCreateAt, maySee, maySetCommentState } from '../auth/access.ts';
import {
  createComment,
  findComment,
  readComments,
  setCommentState,
} from '../db/collections/comments.ts';
import {
  ANCHOR_QUERY_RULE,
  ANCHOR_RULE,
  asActorId,
  asAnchor,
  asAnchorQuery,
  asObject,
  asObjectId,
  asParentId,
  asText,
} from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** Comment, feedback, message and reaction alike: one form, told apart by kind. */
export function commentRoutes(db: Db, decisions: readonly string[]): Router {
  const routes = Router();

  routes.param('id', requireId('comment'));

  // A comment is as visible as what it is about; 404 so its existence stays hidden too.
  const seeing = guard(
    (actor, id) => maySee(db, actor, { kind: 'comment', id }),
    404,
    'unknown comment',
  );

  routes.post('/comments', async (request, response) => {
    const body = bodyOf(request);
    const kind = asText(body['kind']);
    const anchor = asAnchor(body['anchor']);
    const content = asObject(body['body']);
    const parentId = asObjectId(body['parentId']);
    const state = asText(body['state']);

    if (kind === undefined) {
      return fail(response, 400, 'kind is missing');
    }
    if (anchor === undefined) {
      return fail(response, 400, ANCHOR_RULE);
    }
    if (content === undefined) {
      return fail(response, 400, 'body must be an object');
    }
    const unusable = unusableField(body, { parentId, state });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    // maySee finds no comment or task that does not exist yet, so a new one points only at
    // something older and no chain closes into a circle, which maySee would follow forever.
    const actor = actorOf(request);
    if (!(await maySee(db, actor, anchor))) {
      return fail(response, 404, 'unknown anchor');
    }
    if (parentId !== undefined && !(await maySee(db, actor, { kind: 'comment', id: parentId }))) {
      return fail(response, 404, 'unknown parent');
    }
    // Saying something takes speak where it hangs, a first state that is a decision decide too.
    const places = [anchor, ...(parentId === undefined ? [] : [{ kind: 'comment', id: parentId }])];
    if (!(await mayCreateAt(db, actor, 'speak', places))) {
      return fail(response, 403, 'not allowed to say something here');
    }
    const deciding = state !== undefined && decisions.includes(state);
    if (deciding && !(await mayCreateAt(db, actor, 'decide', places))) {
      return fail(response, 403, 'not allowed to decide here');
    }

    response.status(201).json(
      await createComment(db, {
        kind,
        anchor,
        createdBy: actor.actorId,
        body: content,
        ...defined({ parentId, state }),
      }),
    );
  });

  routes.get('/comments/:id', seeing, async (request, response) => {
    response.json(await findComment(db, idOf(request)));
  });

  /** Everything said about one thing, oldest first; with since only what came after it. */
  routes.get('/comments', async (request, response) => {
    const anchor = asAnchorQuery(request.query);
    const parentId = asParentId(request.query['parentId']);
    const kind = asText(request.query['kind']);
    const state = asText(request.query['state']);
    const createdBy = asActorId(request.query['createdBy']);
    const since = asObjectId(request.query['since']);

    if (anchor === undefined) {
      return fail(response, 400, ANCHOR_QUERY_RULE);
    }
    const unusable = unusableField(request.query, { parentId, kind, state, createdBy, since });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }
    if (!(await maySee(db, actorOf(request), anchor))) {
      return fail(response, 404, 'unknown anchor');
    }

    response.json(
      await readComments(db, { anchor, ...defined({ parentId, kind, state, createdBy, since }) }),
    );
  });

  /** Moves the state; who moved it and why land in the events of the comment, D8.16. */
  routes.patch('/comments/:id', seeing, async (request, response) => {
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
    if (!(await maySetCommentState(db, actor, id, state, decisions))) {
      return fail(response, 403, 'not allowed to change this comment');
    }

    response.json(
      await setCommentState(db, id, {
        state,
        changedBy: actor.actorId,
        ...defined({ reason }),
      }),
    );
  });

  return routes;
}
