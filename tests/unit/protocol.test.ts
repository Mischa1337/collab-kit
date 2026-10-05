import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncUpdate,
  handleMessage,
  MessageRefused,
} from '../../src/realtime/protocol.ts';

// Every Awareness runs a timer until it is destroyed.
const awarenesses: Awareness[] = [];
afterEach(() => {
  for (const awareness of awarenesses.splice(0)) {
    awareness.destroy();
  }
});

/** The service side of one workpiece; mayAnnounce says who may speak for which client. */
function service(mayAnnounce: (clientId: number) => boolean = () => true, mayWrite = true) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  awarenesses.push(awareness);

  const context = {
    doc,
    awareness,
    origin: 'alice',
    maxAwarenessBytes: 1024,
    mayAnnounce,
    mayWrite,
  };
  return { doc, awareness, context };
}

/** A client's step 2: what it holds that the service, by its state vector, lacks. */
function stepTwoOf(client: Y.Doc, held: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep2(encoder, client, Y.encodeStateVector(held));
  return encoding.toUint8Array(encoder);
}

/** A client that holds exactly what the service holds, as a returning one does. */
function copyOf(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/** Plays the tool: the service itself never builds a Yjs type. */
function written(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, text);
  return doc;
}

/** A client's step 1: this is what I have. */
function stepOneOf(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** One awareness entry as a client sends it: which client, its clock, and its state. */
function presence(clientId: number, clock: number, state: unknown): Uint8Array {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, 1);
  encoding.writeVarUint(update, clientId);
  encoding.writeVarUint(update, clock);
  encoding.writeVarString(update, JSON.stringify(state));

  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 1);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
  return encoding.toUint8Array(message);
}

/** The close code a refusal carries, or undefined when nothing was refused. */
function refusalOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof MessageRefused ? error.closeCode : undefined;
  }
  return undefined;
}

describe('what the service sends', () => {
  it('opens with its state vector and nothing else', () => {
    expect([...encodeSyncStep1(new Y.Doc())]).toEqual([0, 0, 1, 0]);
  });

  it('puts a change behind the kinds sync and update, bytes untouched', () => {
    const update = Y.encodeStateAsUpdate(written('x'));
    const message = decoding.createDecoder(encodeSyncUpdate(update));

    expect(decoding.readVarUint(message)).toBe(0);
    expect(decoding.readVarUint(message)).toBe(syncProtocol.messageYjsUpdate);
    expect(decoding.readVarUint8Array(message)).toEqual(update);
  });

  it('puts the awareness of the named clients behind the kind awareness', () => {
    const client = new Awareness(new Y.Doc());
    awarenesses.push(client);
    client.setLocalState({ name: 'alice' });

    const message = decoding.createDecoder(encodeAwareness(client, [client.clientID]));

    expect(decoding.readVarUint(message)).toBe(1);
    const update = decoding.createDecoder(decoding.readVarUint8Array(message));
    expect(decoding.readVarUint(update)).toBe(1);
    expect(decoding.readVarUint(update)).toBe(client.clientID);
  });
});

describe('what the service receives', () => {
  it('answers step 1 with everything the sender is missing', () => {
    const { doc, context } = service();
    doc.getText('t').insert(0, 'beim Dienst');
    const client = new Y.Doc();

    const reply = handleMessage(context, stepOneOf(client));

    const decoder = decoding.createDecoder(reply!);
    expect(decoding.readVarUint(decoder)).toBe(0);
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), client, null);
    expect(client.getText('t').toString()).toBe('beim Dienst');
  });

  it('applies a change in the name of its sender and answers nothing', () => {
    const { doc, context } = service();
    let origin: unknown;
    doc.on('update', (_update: Uint8Array, from: unknown) => {
      origin = from;
    });

    const reply = handleMessage(context, encodeSyncUpdate(Y.encodeStateAsUpdate(written('neu'))));

    expect(reply).toBeUndefined();
    expect(doc.getText('t').toString()).toBe('neu');
    expect(origin).toBe('alice');
  });

  it('throws on anything unusable, a broken change included', () => {
    const { context } = service();
    const unusable = [[], [0], [0, 7], [0, 0], [0, 2, 3, 1, 2, 3], [1], [1, 3, 1, 2]];

    for (const bytes of unusable) {
      expect(() => handleMessage(context, new Uint8Array(bytes))).toThrow();
    }
  });

  it('ignores a kind it does not know', () => {
    expect(handleMessage(service().context, new Uint8Array([5, 1, 2]))).toBeUndefined();
  });
});

describe('what the service takes from a reader', () => {
  const reader = () => service(() => true, false);

  it('answers its step 1 like anyone', () => {
    const { doc, context } = reader();
    doc.getText('t').insert(0, 'zum Lesen');
    const client = new Y.Doc();

    const decoder = decoding.createDecoder(handleMessage(context, stepOneOf(client))!);
    expect(decoding.readVarUint(decoder)).toBe(0);
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), client, null);
    expect(client.getText('t').toString()).toBe('zum Lesen');
  });

  it('lets the empty step 2 of a fresh reader through', () => {
    const { doc, context } = reader();
    doc.getText('t').insert(0, 'Stand');

    expect(handleMessage(context, stepTwoOf(new Y.Doc(), doc))).toBeUndefined();
  });

  it('lets a returning reader repeat what the workpiece holds, deletions included', () => {
    const { doc, context } = reader();
    doc.getText('t').insert(0, 'Entwurf eins');
    doc.getText('t').delete(7, 5);
    const returning = copyOf(doc);

    expect(handleMessage(context, stepTwoOf(returning, doc))).toBeUndefined();
    expect(
      handleMessage(context, encodeSyncUpdate(Y.encodeStateAsUpdate(returning))),
    ).toBeUndefined();
  });

  it('refuses anything new with 1008 and applies none of it', () => {
    const { doc, context } = reader();
    doc.getText('t').insert(0, 'Entwurf');
    const typing = copyOf(doc);
    typing.getText('t').insert(7, ' zwei');
    const deleting = copyOf(doc);
    deleting.getText('t').delete(0, 3);

    expect(refusalOf(() => handleMessage(context, stepTwoOf(typing, doc)))).toBe(1008);
    expect(refusalOf(() => handleMessage(context, stepTwoOf(deleting, doc)))).toBe(1008);
    expect(doc.getText('t').toString()).toBe('Entwurf');
  });
});

describe('awareness', () => {
  it('applies a presence the sender may speak for', () => {
    const { awareness, context } = service();

    handleMessage(context, presence(7, 1, { name: 'alice' }));

    expect(awareness.getStates().get(7)).toEqual({ name: 'alice' });
  });

  it('refuses a presence of somebody else with 1008 before applying it', () => {
    const { awareness, context } = service((clientId) => clientId !== 7);

    expect(refusalOf(() => handleMessage(context, presence(7, 1, { name: 'mallory' })))).toBe(1008);
    expect(awareness.getStates().has(7)).toBe(false);
  });

  it('refuses a presence larger than allowed with 1009', () => {
    const { awareness, context } = service();

    expect(
      refusalOf(() => handleMessage(context, presence(8, 1, { blob: 'x'.repeat(2048) }))),
    ).toBe(1009);
    expect(awareness.getStates().has(8)).toBe(false);
  });
});
