/** A text of the workpiece: a Y.Text shown as change lists, with an undo for own changes only. */

import * as Y from 'yjs';

import type { SharedText, TextDelta, TextPosition } from './api.ts';

/** What a text anchor holds in its unit: where it starts, and where it ends if it spans. */
interface Span {
  readonly start: TextPosition;
  readonly end?: TextPosition;
}

/** A text the session handed out, with the history its undo works on. */
export interface OpenText {
  readonly shared: SharedText;
  readonly history: Y.UndoManager;
}

/** A text of the doc as the library shows it; its own origins tell own changes from all others. */
export function textOf(
  doc: Y.Doc,
  text: Y.Text,
  workpieceId: string,
  checkWrite: () => void,
): OpenText {
  // Own changes go in under tracked, or under untracked when kept out of undo.
  const tracked = Symbol('text');
  const untracked = Symbol('text, not undoable');
  // Only what went through update, so undo never takes back the work of others.
  const history = new Y.UndoManager(text, { trackedOrigins: new Set([tracked]) });

  /** A place that moves along; assoc -1 holds to the letter before it instead of the one after. */
  const positionAt = (index: number, assoc = 0): TextPosition =>
    Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, index, assoc),
    ) as TextPosition;

  /** Where a place stands now, if it lies in this text. */
  const indexOf = (position: TextPosition): number | undefined => {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(position),
      doc,
    );
    // A place in another text of the same doc is no place in this one.
    return absolute !== null && absolute.type === text ? absolute.index : undefined;
  };

  const shared: SharedText = {
    get value() {
      return text.toString();
    },
    delta: () => text.toDelta() as TextDelta,
    update: (delta, { undoable = true } = {}) => {
      checkWrite();
      // One transaction, so CK gets one change.
      doc.transact(() => text.applyDelta([...delta]), undoable ? tracked : untracked);
    },
    onChange: (listener) => {
      const observer = ({ delta, transaction: { origin } }: Y.YTextEvent): void => {
        // Nothing to show, as when formatting met a letter already deleted.
        if (delta.length > 0) {
          listener(delta as TextDelta, origin === tracked || origin === untracked);
        }
      };
      text.observe(observer);
      return () => text.unobserve(observer);
    },
    cursor: (index) => positionAt(index),
    indexOf,
    anchor: (index, length = 0) => {
      // The start holds to the letter after it, the end to the one before, so edges stay outside.
      const span: Span =
        length > 0
          ? { start: positionAt(index), end: positionAt(index + length, -1) }
          : { start: positionAt(index) };
      return { kind: 'workpiece', id: workpieceId, unit: JSON.stringify(span) };
    },
    rangeOf: (anchor) => {
      const span =
        anchor.kind === 'workpiece' && anchor.id === workpieceId ? spanIn(anchor.unit) : undefined;
      if (span === undefined) {
        return undefined;
      }
      const start = indexOf(span.start);
      const end = span.end === undefined ? start : indexOf(span.end);
      if (start === undefined || end === undefined) {
        return undefined;
      }
      // Deleted whole, both ends meet where it stood.
      return { index: start, length: Math.max(0, end - start) };
    },
    undo: () => {
      checkWrite();
      return history.undo() !== null;
    },
    redo: () => {
      checkWrite();
      return history.redo() !== null;
    },
    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
  };
  return { shared, history };
}

/** The span a unit holds, if anchor wrote it; a key or any other text holds none. */
function spanIn(unit: string | undefined): Span | undefined {
  if (unit === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unit);
  } catch {
    return undefined;
  }
  if (!isPlace(parsed) || !isPlace(parsed['start'])) {
    return undefined;
  }
  const end = parsed['end'];
  if (end === undefined) {
    return { start: parsed['start'] };
  }
  return isPlace(end) ? { start: parsed['start'], end } : undefined;
}

/** Whether a value is an object of fields, as a place in JSON is. */
function isPlace(value: unknown): value is TextPosition {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
