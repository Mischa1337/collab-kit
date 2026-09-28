import { Router } from 'express';
import type { Db, ObjectId } from 'mongodb';

import { maySee, maySetCommentState } from '../auth/access.ts';
import {
  createComment,
  findComment,
  readComments,
  ROOT,
  setCommentState,
} from '../db/collections/comments.ts';
import {
  asActorId,
  asAnchor,
  asAnchorQuery,
  asObject,
  asObjectId,
  asText,
} from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** Comment, feedback, message and reaction alike: one form, told apart by kind. */
export function commentRoutes(db: Db): Router {
  const routes = Router();

  routes.param('id', requireId('comment'));

  // A comment is as visible as what it is about; 404 so its existence stays hidden too.
  const seeing = guard(
    (actor, id) => maySee(db, actor, { kind: 'comment', id }),
    404,
    'unknown comment',
  );
  // 404 as well while the rule equals seeing; a narrower one will want 403.
  const marking = guard((actor, id) => maySetCommentState(db, actor, id), 404, 'unknown comment');

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
      return fail(response, 400, 'anchor needs kind and id, and a unit only as text');
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
      return fail(response, 400, 'anchorKind and anchorId are needed, then unit or scope=whole');
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
  routes.patch('/comments/:id', marking, async (request, response) => {
    const body = bodyOf(request);
    const state = asText(body['state']);
    const reason = asText(body['reason']);

    if (state === undefined) {
      return fail(response, 400, 'state is missing');
    }
    if (unusableField(body, { reason }) !== undefined) {
      return fail(response, 400, 'reason is unusable');
    }

    response.json(
      await setCommentState(db, idOf(request), {
        state,
        changedBy: actorOf(request).actorId,
        ...defined({ reason }),
      }),
    );
  });

  return routes;
}

/** none asks for the starts of the threads, a comment key for the answers to that one. */
function asParentId(raw: unknown): ObjectId | typeof ROOT | undefined {
  return raw === 'none' ? ROOT : asObjectId(raw);
}
