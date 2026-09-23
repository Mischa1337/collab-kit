import { Router } from 'express';
import type { Db } from 'mongodb';

import { mayOpenDocument } from '../auth/access.ts';
import { createDocument, findDocument } from '../db/collections/documents.ts';
import { readUpdatesSince } from '../db/collections/updates.ts';
import type { DocumentHub } from '../realtime/hub.ts';
import { actorOf, asObject, asObjectId, asText, bodyOf, fail } from './http.ts';

/**
 * The working on a document runs over the WebSocket, which is why nothing here writes
 * into one. These routes are about the document as a thing: creating it, reading what
 * the tool declared about it, and reading the chain of what happened to it.
 */
export function documentRoutes(db: Db, hub: DocumentHub): Router {
  const routes = Router();

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
      ...(contract === undefined ? {} : { contract }),
    });

    // Born outside every room and therefore openable by nobody yet. Putting it into
    // one is a separate step, because the room bundles and does not own.
    response.status(201).json(document);
  });

  routes.get('/documents/:id', async (request, response) => {
    const id = asObjectId(request.params['id']);

    if (id === undefined) {
      return fail(response, 400, 'malformed document key');
    }

    const document = await findDocument(db, id);
    const actor = actorOf(request);

    if (
      document === null ||
      (document.createdBy !== actor.actorId &&
        !(await mayOpenDocument({ db, actor, documentId: id })))
    ) {
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
      ...(document.stateThrough === undefined ? {} : { stateThrough: document.stateThrough }),
      ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
    });
  });

  /**
   * The chain of changes, oldest first, `since` as the cut. What the bytes mean is
   * the business of the tool; what the service adds is who and when.
   */
  routes.get('/documents/:id/updates', async (request, response) => {
    const id = asObjectId(request.params['id']);

    if (id === undefined) {
      return fail(response, 400, 'malformed document key');
    }
    if (!(await mayOpenDocument({ db, actor: actorOf(request), documentId: id }))) {
      return fail(response, 404, 'unknown document');
    }

    const since = asObjectId(request.query['since']);
    const updates = await readUpdatesSince(db, id, since);

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
  routes.post('/documents/:id/checkpoints', async (request, response) => {
    const id = asObjectId(request.params['id']);

    if (id === undefined) {
      return fail(response, 400, 'malformed document key');
    }
    if (!(await mayOpenDocument({ db, actor: actorOf(request), documentId: id }))) {
      return fail(response, 404, 'unknown document');
    }

    const body = bodyOf(request);
    const label = asText(body['label']);
    const reason = asText(body['reason']);

    response.status(201).json(
      await hub.checkpoint(id, {
        actorId: actorOf(request).actorId,
        ...(label === undefined ? {} : { label }),
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  });

  return routes;
}
