/** A text of the workpiece: a Y.Text shown as change lists, with an undo for own changes only. */

import * as Y from 'yjs';

import type { SharedText, TextDelta, TextPosition } from './api.ts';

/** A text the session handed out, with the history its undo works on. */
export interface OpenText {
  readonly shared: SharedText;
  readonly history: Y.UndoManager;
}

/** A text of the doc as the library shows it; its own origins tell own changes from all others. */
export function textOf(doc: Y.Doc, text: Y.Text, checkWrite: () => void): OpenText {
  // Own changes go in under tracked, or under untracked when kept out of undo.
  const tracked = Symbol('text');
  const untracked = Symbol('text, not undoable');
  // Only what went through update, so undo never takes back the work of others.
  const history = new Y.UndoManager(text, { trackedOrigins: new Set([tracked]) });

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
    cursor: (index) =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index)) as TextPosition,
    indexOf: (position) => {
      const absolute = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(position),
        doc,
      );
      // A place in another text of the same doc is no place in this one.
      return absolute !== null && absolute.type === text ? absolute.index : undefined;
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
