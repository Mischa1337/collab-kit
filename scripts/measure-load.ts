/**
 * Measures what it costs to open a document, depending on how long its chain of
 * changes has grown. Answers whether folding is needed at all, and from when.
 *
 *   npm run measure
 */
import { Binary, ObjectId } from 'mongodb';
import * as Y from 'yjs';

import { readConfig } from '../src/config.ts';
import { applyDefinitions } from '../src/db/apply.ts';
import { connect } from '../src/db/client.ts';
import { createDocument } from '../src/db/documents.ts';
import { collectionDefinitions } from '../src/db/schemas.ts';
import { readUpdatesSince, type UpdateRecord } from '../src/db/updates.ts';

const SIZES = [1_000, 10_000, 50_000];

const config = readConfig();
const storage = await connect({ uri: config.mongoUri, database: 'collab_kit_measure' });
await applyDefinitions(storage.db, collectionDefinitions);

function millis(from: bigint): string {
  return `${(Number(process.hrtime.bigint() - from) / 1_000_000).toFixed(0)} ms`;
}

console.log('Änderungen | holen | einzeln anwenden | zusammenfassen + anwenden | Kette | gefaltet');
console.log('-'.repeat(92));

for (const size of SIZES) {
  const document = await createDocument(storage.db, {
    name: `Messung ${size}`,
    createdBy: 'alice',
  });

  // Tippen, mit jedem fünften Anschlag ein Löschen, damit Reste entstehen.
  const writer = new Y.Doc();
  const captured: Uint8Array[] = [];
  writer.on('update', (update: Uint8Array) => captured.push(update));

  const text = writer.getText('t');
  for (let index = 0; index < size; index += 1) {
    if (index % 5 === 4 && text.length > 0) {
      text.delete(text.length - 1, 1);
    } else {
      text.insert(text.length, 'x');
    }
  }

  const rows: UpdateRecord[] = captured.map((update, index) => ({
    _id: new ObjectId(),
    documentId: document._id,
    update: new Binary(update),
    actorId: index % 2 === 0 ? 'alice' : 'bob',
    createdAt: new Date(),
  }));

  for (let start = 0; start < rows.length; start += 1_000) {
    await storage.db.collection('updates').insertMany(rows.slice(start, start + 1_000));
  }

  const fetchStart = process.hrtime.bigint();
  const stored = await readUpdatesSince(storage.db, document._id);
  const fetched = millis(fetchStart);

  const oneByOneStart = process.hrtime.bigint();
  const oneByOne = new Y.Doc();
  for (const row of stored) {
    Y.applyUpdate(oneByOne, new Uint8Array(row.update.buffer));
  }
  const applied = millis(oneByOneStart);

  const mergedStart = process.hrtime.bigint();
  const merged = new Y.Doc();
  Y.applyUpdate(merged, Y.mergeUpdates(stored.map((row) => new Uint8Array(row.update.buffer))));
  const mergedTime = millis(mergedStart);

  const chainBytes = stored.reduce((sum, row) => sum + row.update.length(), 0);
  const foldedBytes = Y.encodeStateAsUpdate(oneByOne).length;

  console.log(
    `${String(stored.length).padStart(10)} | ${fetched.padStart(5)} | ${applied.padStart(16)} | ${mergedTime.padStart(25)} | ${`${(chainBytes / 1024).toFixed(0)} KB`.padStart(5)} | ${`${(foldedBytes / 1024).toFixed(0)} KB`.padStart(8)}`,
  );
}

await storage.db.dropDatabase();
await storage.close();
