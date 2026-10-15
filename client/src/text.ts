/** A text of the workpiece: a Y.Text shown as change lists, with an undo for own changes only. */

import * as Y from 'yjs';

import type { SharedText, TextDelta, TextPosition } from './api.ts';

/** A text the session handed out, with the history its undo works on. */
export interface OpenText {
  readonly shared: SharedText;
  readonly history: Y.UndoManager;
}

/** A text of the doc as the library shows it; its own origin tells own changes from all others. */
export function textOf(doc: Y.Doc, text: Y.Text, checkWrite: () => void): OpenText {
  const origin = Symbol('text');
  // Only what went through update, so undo never takes back the work of others.
  const history = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) });

  const shared: SharedText = {
    get value() {
      return text.toString();
    },
    delta: () => text.toDelta() as TextDelta,
    update: (delta) => {
      checkWrite();
      // One transaction, so CK gets one change.
      doc.transact(() => text.applyDelta([...delta]), origin);
    },
    onChange: (listener) => {
      const observer = (event: Y.YTextEvent): void => {
        // Nothing to show, as when formatting met a letter already deleted.
        if (event.delta.length > 0) {
          listener(event.delta as TextDelta, event.transaction.origin === origin);
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
  };
  return { shared, history };
}
