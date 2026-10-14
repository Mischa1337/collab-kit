import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { isFormatCleanup } from '../../src/realtime/conflicts/deletions.ts';

/** Every transaction of the doc from now on, with its origin and whether it was a cleanup. */
function watched(doc: Y.Doc): [unknown, boolean][] {
  const seen: [unknown, boolean][] = [];
  doc.on('afterTransaction', (transaction: Y.Transaction) => {
    seen.push([transaction.origin, isFormatCleanup(transaction)]);
  });
  return seen;
}

describe('formatting that Yjs tidies up', () => {
  it('knows the change Yjs makes by itself when marks stand around a deleted letter', () => {
    const start = new Y.Doc();
    start.getText('t').insert(0, 'abcdef');
    const [ck, alice, bob] = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    for (const doc of [ck, alice, bob]) {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(start));
    }

    // Alice makes c bold while bob deletes it.
    alice.getText('t').format(2, 1, { bold: true });
    bob.getText('t').delete(2, 1);

    // Only a doc that knows the text as a text tidies it up, as CK does with one inside a map.
    ck.getText('t');
    const seen = watched(ck);
    Y.applyUpdate(ck, Y.encodeStateAsUpdate(alice), 'alice');
    Y.applyUpdate(ck, Y.encodeStateAsUpdate(bob), 'bob');

    expect(seen).toContainEqual([null, true]);
    expect(seen.filter(([origin]) => origin !== null).map(([, cleanup]) => cleanup)).toEqual([
      false,
      false,
    ]);
  });

  it('does not take writing or deleting letters for it', () => {
    const doc = new Y.Doc();
    const seen = watched(doc);

    doc.getText('t').insert(0, 'abc', { bold: true });
    doc.getText('t').delete(0, 1);

    expect(seen.map(([, cleanup]) => cleanup)).toEqual([false, false]);
  });
});
