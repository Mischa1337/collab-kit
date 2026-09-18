import type { Db } from 'mongodb';
import type { ObjectId } from 'mongodb';

import type { Actor } from './token.ts';

export interface AccessRequest {
  readonly db: Db;
  readonly actor: Actor;
  readonly documentId: ObjectId;
}

/**
 * The single place that decides who may open a document. It knows neither HTTP nor
 * WebSocket, so both ways in ask the same question.
 *
 * Every authenticated actor passes for now. Which role may do what is meant to be set
 * by the tool through the grants of a room, so inventing a rule here would decide for
 * it. When that evaluation arrives, it arrives in this function and nowhere else.
 */
export async function mayOpenDocument(_request: AccessRequest): Promise<boolean> {
  return true;
}
