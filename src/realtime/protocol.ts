import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

/** The first number of every message, as in y-websocket, so a standard client just works. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

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

/** The awareness entries of these clients as one message. */
export function encodeAwareness(
  awareness: awarenessProtocol.Awareness,
  clientIds: number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds),
  );
  return encoding.toUint8Array(encoder);
}

/** What an incoming message is applied to, and on whose behalf. */
interface MessageContext {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  /** Who sent it: the change is stored under them and not sent back to them. */
  readonly origin: unknown;
}

/** Applies one message and returns the answer if the protocol wants one; the bytes stay opaque. */
export function handleMessage(context: MessageContext, data: Uint8Array): Uint8Array | undefined {
  // The first number says which kind of message follows.
  const decoder = decoding.createDecoder(data);
  const kind = decoding.readVarUint(decoder);

  if (kind === MESSAGE_SYNC) {
    // The answer is built as a sync message: step 1 gets step 2 back, the rest gets nothing.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, context.doc, context.origin);

    // Length one means the kind byte alone, so there is nothing to answer.
    return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : undefined;
  }

  // Awareness is only applied here; passing it on is up to the hub.
  if (kind === MESSAGE_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(
      context.awareness,
      decoding.readVarUint8Array(decoder),
      context.origin,
    );
  }

  // Any other kind is ignored.
  return undefined;
}
