import * as Y from 'yjs';

import type { UnitContainer } from '../../db/collections/workpieces.ts';
import { asNonBlank } from '../../utils/input.ts';

/** The maps whose keys are units, each by its path, ready to be looked up. */
export type Containers = ReadonlySet<string>;

/** The maps a workpiece names as holding units, looked up by path. */
export function containersOf(units: readonly UnitContainer[]): Containers {
  return new Set(units.map((container) => pathKey(container.path)));
}

/** The unit of a piece: the key under which it, or what holds it, sits directly in a container. */
export function unitOf(item: Y.Item, containers: Containers): string | undefined {
  // Up from the piece; the first container on the way is the innermost.
  for (let piece: Y.Item | null = item; piece !== null; piece = placeOf(piece)) {
    const key = piece.parentSub;
    if (key !== null && isContainer(piece.parent, containers)) {
      // A blank key could never be asked for, so it names no unit.
      return asNonBlank(key);
    }
  }
  return undefined;
}

/** Whether the workpiece names the type a piece sits in as holding units. */
function isContainer(parent: Y.Item['parent'], containers: Containers): boolean {
  if (containers.size === 0 || !(parent instanceof Y.AbstractType)) {
    return false;
  }
  const path = pathOf(parent);
  return path !== undefined && containers.has(pathKey(path));
}

/** A root type by its name, one below by the path of its parent and its key; none in a list. */
function pathOf(type: Y.AbstractType<unknown>): string[] | undefined {
  // eslint-disable-next-line no-underscore-dangle
  const item = type._item;
  if (item === null) {
    return [Y.findRootTypeKey(type)];
  }
  // In an array or a text it sits at a position, and a position is no key.
  if (item.parentSub === null || !(item.parent instanceof Y.AbstractType)) {
    return undefined;
  }
  const above = pathOf(item.parent);
  return above === undefined ? undefined : [...above, item.parentSub];
}

/** The key under which a path is looked up, as a set cannot compare arrays. */
function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

/** The item of the map, text or array a piece sits in; null at the top of the document. */
export function placeOf(item: Y.Item): Y.Item | null {
  // Yjs offers no other way from a type to the item that holds it.
  // eslint-disable-next-line no-underscore-dangle
  return item.parent instanceof Y.AbstractType ? item.parent._item : null;
}
