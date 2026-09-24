import type { CollectionDefinition } from './apply.ts';
import { actorsDefinition } from './collections/actors.ts';
import { commentsDefinition } from './collections/comments.ts';
import { workpiecesDefinition } from './collections/workpieces.ts';
import { eventsDefinition } from './collections/events.ts';
import { groupsDefinition } from './collections/groups.ts';
import { roomsDefinition } from './collections/rooms.ts';
import { tasksDefinition } from './collections/tasks.ts';
import { updatesDefinition } from './collections/updates.ts';

/** Warn instead of refuse while the field layout still moves; drop once the shapes settle. */
function whileDeveloping(definition: CollectionDefinition): CollectionDefinition {
  return { ...definition, validationAction: 'warn' };
}

/** All collections; the interface is checked by TypeScript, the definition enforced by MongoDB. */
export const collectionDefinitions: readonly CollectionDefinition[] = [
  actorsDefinition,
  commentsDefinition,
  workpiecesDefinition,
  eventsDefinition,
  groupsDefinition,
  roomsDefinition,
  tasksDefinition,
  updatesDefinition,
].map(whileDeveloping);
