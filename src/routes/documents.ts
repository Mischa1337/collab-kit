import { Router } from 'express';
import type { Db } from 'mongodb';

import { mayOpenDocument, mayReadDocument } from '../auth/access.ts';
import { createDocument, findDocument } from '../db/collections/documents.ts';
import { readUpdatesSince } from '../db/collections/updates.ts';
import { asObject, asObjectId, asText } from '../input.ts';
import { defined } from '../optional.ts';
import type { DocumentHub } from '../realtime/hub.ts';
import { actorOf, bodyOf, fail, guard, idOf, requireId } from './http.ts';

/**
 * The working on a document runs over the WebSocket, which is why nothing here writes
 * into one. These routes are about the document as a thing: creating it, reading what
 * the tool declared about it, and reading the chain of what happened to it.
 */
export function documentRoutes(db: Db, hub: DocumentHub): Router {
  const routes = Router();

  routes.param('id', requireId('document'));

  const opening = guard(
    (actor, id) => mayOpenDocument({ db, actor, documentId: id }),
    404,
    'unknown document',
  );

  routes.post('/documents', async (request, response) => {
    const body = bodyOf(request);
    const name = asText(body['name']);

    if (name === undefined) {
      return fail(response, 400, 'name is missing');
    }

    const contract = asObject(body['contract']);
    const document = await createDocument(db, {
      name,
      createdBy: actorOf(request).actorId,
      ...defined({ contract }),
    });

    // Born outside every room and therefore openable by nobody yet. Putting it into
    // one is a separate step, because the room bundles and does not own.
    response.status(201).json(document);
  });

  routes.get('/documents/:id', async (request, response) => {
    const document = await findDocument(db, idOf(request));

    if (document === null || !(await mayReadDocument(db, actorOf(request), document))) {
      return fail(response, 404, 'unknown document');
    }

    // Named field by field rather than handed out as it is stored. The folded state
    // stays out: it is the shortcut for loading and belongs to the socket, not to a
    // client reading about the document.
    response.json({
      _id: document._id,
      name: document.name,
      contract: document.contract,
      createdAt: document.createdAt,
      createdBy: document.createdBy,
      ...defined({ stateThrough: document.stateThrough, updatedAt: document.updatedAt }),
    });
  });

  /**
   * The chain of changes, oldest first, `since` as the cut. What the bytes mean is
   * the business of the tool; what the service adds is who and when.
   */
  routes.get('/documents/:id/updates', opening, async (request, response) => {
    const since = asObjectId(request.query['since']);
    const updates = await readUpdatesSince(db, idOf(request), since);

    response.json(
      updates.map((update) => ({
        _id: update._id,
        actorId: update.actorId,
        createdAt: update.createdAt,
        bytes: update.update.length(),
      })),
    );
  });

  /**
   * Holds this moment under a name. `reason` is the only place in the whole model
   * where the why of a change can live, which is why it is worth its own route.
   */
  routes.post('/documents/:id/checkpoints', opening, async (request, response) => {
    const body = bodyOf(request);
    const label = asText(body['label']);
    const reason = asText(body['reason']);

    response.status(201).json(
      await hub.checkpoint(idOf(request), {
        actorId: actorOf(request).actorId,
        ...defined({ label, reason }),
      }),
    );
  });

  return routes;
}
