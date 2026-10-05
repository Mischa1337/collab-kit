import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

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

/** A message turned down on purpose; the close code tells the client why. */
export class MessageRefused extends Error {
  readonly closeCode: number;

  constructor(closeCode: number, message: string) {
    super(message);
    this.name = 'MessageRefused';
    this.closeCode = closeCode;
  }
}

/** What an incoming message is applied to, and on whose behalf. */
interface MessageContext {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  /** Who sent it: the change is stored under them and not sent back to them. */
  readonly origin: unknown;
  /** Largest awareness update taken, since presence goes to everyone every 15 s. */
  readonly maxAwarenessBytes: number;
  /** Whether the sender may speak for this awareness client. */
  mayAnnounce(clientId: number): boolean;
  /** Whether the sender may change the workpiece; a reader follows along and changes nothing. */
  readonly mayWrite: boolean;
}

/** Applies one message and answers if the protocol wants it; anything unusable throws. */
export function handleMessage(context: MessageContext, data: Uint8Array): Uint8Array | undefined {
  // The first number says which kind of message follows.
  const decoder = decoding.createDecoder(data);
  const kind = decoding.readVarUint(decoder);

  if (kind === MESSAGE_SYNC && !context.mayWrite) {
    return answerReader(context.doc, decoder);
  }

  if (kind === MESSAGE_SYNC) {
    // The answer is built as a sync message: step 1 gets step 2 back, the rest gets nothing.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    // y-protocols would only print a broken update; thrown, it is handled like any other.
    syncProtocol.readSyncMessage(decoder, encoder, context.doc, context.origin, (error) => {
      throw error;
    });

    // Length one means the kind byte alone, so there is nothing to answer.
    return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : undefined;
  }

  // Awareness is only applied here; passing it on is up to the hub.
  if (kind === MESSAGE_AWARENESS) {
    const update = decoding.readVarUint8Array(decoder);
    if (update.length > context.maxAwarenessBytes) {
      throw new MessageRefused(1009, 'awareness update too large');
    }
    // Checked before anything is applied: nobody speaks for a client of another person.
    for (const clientId of clientIdsIn(update)) {
      if (!context.mayAnnounce(clientId)) {
        throw new MessageRefused(1008, 'awareness of a client that belongs to somebody else');
      }
    }
    awarenessProtocol.applyAwarenessUpdate(context.awareness, update, context.origin);
  }

  // Any other kind is ignored.
  return undefined;
}

/** A reader gets its answers, but whatever it sends must bring nothing the workpiece lacks. */
function answerReader(doc: Y.Doc, decoder: decoding.Decoder): Uint8Array | undefined {
  const step = decoding.readVarUint(decoder);

  // Asking what it misses is reading, so it gets the same answer as everyone.
  if (step === syncProtocol.messageYjsSyncStep1) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncStep1(decoder, encoder, doc);
    return encoding.toUint8Array(encoder);
  }
  if (step !== syncProtocol.messageYjsSyncStep2 && step !== syncProtocol.messageYjsUpdate) {
    throw new Error(`unknown sync message ${step}`);
  }

  // Every client answers the greeting with what it holds; a reader may only repeat the workpiece.
  if (!bringsNothingNew(doc, decoding.readVarUint8Array(decoder))) {
    throw new MessageRefused(1008, 'read only');
  }
  return undefined;
}

/** Whether every item of the update is known and every deletion done, so it would change nothing. */
function bringsNothingNew(doc: Y.Doc, update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update);
  const known = Y.decodeStateVector(Y.encodeStateVector(doc));

  // A Skip only fills a gap in the encoding and carries nothing.
  const unknownItem = structs.some(
    (struct) =>
      !(struct instanceof Y.Skip) &&
      struct.id.clock + struct.length > (known.get(struct.id.client) ?? 0),
  );
  if (unknownItem) {
    return false;
  }

  // Yjs sends the whole delete set every time, so a returning reader repeats deletions done long ago.
  const deleted = Y.createDeleteSetFromStructStore(doc.store);
  return [...ds.clients].every(([client, ranges]) => {
    const done = deleted.clients.get(client) ?? [];
    return ranges.every((range) =>
      done.some(
        (span) => span.clock <= range.clock && range.clock + range.len <= span.clock + span.len,
      ),
    );
  });
}

/** The client ids an awareness update speaks for, read without applying it. */
function clientIdsIn(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const clientIds: number[] = [];

  for (let entry = 0; entry < count; entry += 1) {
    clientIds.push(decoding.readVarUint(decoder));
    // Clock and state follow; only read past them.
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return clientIds;
}
