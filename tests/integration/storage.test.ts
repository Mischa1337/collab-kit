import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import type { CollectionDefinition } from '../../src/db/apply.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const probe: CollectionDefinition = {
  name: 'probe',
  schema: {
    bsonType: 'object',
    required: ['label'],
    properties: {
      label: { bsonType: 'string' },
    },
  },
  indexes: [{ key: { label: 1 }, name: 'label_unique', unique: true }],
  validationLevel: 'strict',
  validationAction: 'error',
};

let storage: Storage;

/** nameOnly: false narrows the driver's union type down to the full collection info. */
async function readValidator(name: string): Promise<unknown> {
  const [collection] = await storage.db.listCollections({ name }, { nameOnly: false }).toArray();
  return collection?.options?.['validator'];
}

beforeAll(async () => {
  storage = await connect({ uri, database });
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

describe('connect', () => {
  it('reaches the database and answers a ping', async () => {
    await expect(storage.db.command({ ping: 1 })).resolves.toMatchObject({ ok: 1 });
  });

  it('fails fast on an address nobody answers', async () => {
    await expect(
      connect({
        uri: 'mongodb://127.0.0.1:27099/?directConnection=true',
        database,
        serverSelectionTimeoutMs: 500,
      }),
    ).rejects.toThrowError(/cannot reach the database/);
  });
});

describe('applyDefinitions', () => {
  it('creates the collection with its validator and index', async () => {
    await applyDefinitions(storage.db, [probe]);

    expect(await readValidator('probe')).toEqual({ $jsonSchema: probe.schema });

    const indexes = await storage.db.collection('probe').indexes();
    expect(indexes.map((index) => index.name)).toContain('label_unique');
  });

  it('lets the database reject a document that breaks the schema', async () => {
    await applyDefinitions(storage.db, [probe]);

    await expect(storage.db.collection('probe').insertOne({ label: 'fits' })).resolves.toBeTruthy();
    await expect(storage.db.collection('probe').insertOne({ label: 42 })).rejects.toThrowError(
      /Document failed validation/,
    );
  });

  it('only warns when the definition asks for it', async () => {
    await applyDefinitions(storage.db, [
      { ...probe, name: 'lenient', indexes: [], validationAction: 'warn' },
    ]);

    await expect(storage.db.collection('lenient').insertOne({ label: 42 })).resolves.toBeTruthy();
  });

  it('can run again and then carries the changed schema', async () => {
    await applyDefinitions(storage.db, [probe]);
    await applyDefinitions(storage.db, [
      { ...probe, schema: { ...probe.schema, required: ['label', 'note'] } },
    ]);

    expect(await readValidator('probe')).toMatchObject({
      $jsonSchema: { required: ['label', 'note'] },
    });
  });
});
