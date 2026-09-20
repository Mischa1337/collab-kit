import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

/**
 * The wire format of Yjs: every message starts with its kind, so a standard client
 * can talk to this service without a line of protocol code of its own.
 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** "This is what I have." Carries a state vector, no content. */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** A single change, passed on as the opaque bytes it is. */
export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwareness(payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

export interface MessageContext {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  /** Marks where a change came from, so it is not sent back to its sender. */
  readonly origin: unknown;
}

/**
 * Applies one incoming message and returns an answer when the protocol asks for one.
 * Only applyUpdate and state vectors are touched here: what the bytes mean is the
 * business of the connecting tool, never of this service.
 */
export function handleMessage(context: MessageContext, data: Uint8Array): Uint8Array | undefined {
  const decoder = decoding.createDecoder(data);
  const kind = decoding.readVarUint(decoder);

  if (kind === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, context.doc, context.origin);

    // Length one means the kind byte alone, so there is nothing to answer.
    return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : undefined;
  }

  if (kind === MESSAGE_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(
      context.awareness,
      decoding.readVarUint8Array(decoder),
      context.origin,
    );
  }

  return undefined;
}
