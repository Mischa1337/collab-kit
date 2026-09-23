import type { CollectionDefinition } from './apply.ts';
import { actorsDefinition } from './collections/actors.ts';
import { commentsDefinition } from './collections/comments.ts';
import { documentsDefinition } from './collections/documents.ts';
import { eventsDefinition } from './collections/events.ts';
import { groupsDefinition } from './collections/groups.ts';
import { roomsDefinition } from './collections/rooms.ts';
import { tasksDefinition } from './collections/tasks.ts';
import { updatesDefinition } from './collections/updates.ts';

/**
 * While the field layout is still moving, every collection only warns instead of
 * refusing. Drop this once the shapes have settled, and MongoDB refuses again.
 */
function whileDeveloping(definition: CollectionDefinition): CollectionDefinition {
  return { ...definition, validationAction: 'warn' };
}

/**
 * Every collection of the service. Each one is described next to its type: the
 * interface is what TypeScript checks, the definition is what MongoDB enforces.
 */
export const collectionDefinitions: readonly CollectionDefinition[] = [
  actorsDefinition,
  commentsDefinition,
  documentsDefinition,
  eventsDefinition,
  groupsDefinition,
  roomsDefinition,
  tasksDefinition,
  updatesDefinition,
].map(whileDeveloping);
