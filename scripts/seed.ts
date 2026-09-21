/**
 * Creates a room and a document to work against, and prints what a client needs.
 * Deliberately a script: it only calls the same functions a route will call later,
 * it carries no logic of its own.
 *
 *   npm run seed
 */
import { readConfig } from '../src/config.ts';
import { applyDefinitions } from '../src/db/apply.ts';
import { connect } from '../src/db/client.ts';
import { createDocument } from '../src/db/documents.ts';
import { addToRoom, createRoom } from '../src/db/rooms.ts';
import { collectionDefinitions } from '../src/db/schemas.ts';

const config = readConfig();
const storage = await connect({ uri: config.mongoUri, database: config.mongoDb });
await applyDefinitions(storage.db, collectionDefinitions);

const room = await createRoom(storage.db, {
  name: 'Seminarraum',
  createdBy: 'alice',
  settings: {},
});

const document = await createDocument(storage.db, {
  name: 'Entwurf',
  createdBy: 'alice',
  contract: {},
});

await addToRoom(storage.db, room._id, {
  kind: 'document',
  id: document._id,
  addedBy: 'alice',
});

await storage.close();

console.log(`room:     ${room._id.toHexString()}`);
console.log(`document: ${document._id.toHexString()}`);
console.log(`socket:   ws://localhost:${config.port}/ws/${document._id.toHexString()}`);
console.log('token:    npm run token -- alice');
