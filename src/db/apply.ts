import type { Db, Document, IndexDescription } from 'mongodb';

/** strict also checks updates of documents that already break the schema. */
export type ValidationLevel = 'off' | 'moderate' | 'strict';
/** warn only writes to the server log, error refuses the write. */
export type ValidationAction = 'warn' | 'error';

/** One collection of the service: its $jsonSchema plus its indexes, never a tool's structure. */
export interface CollectionDefinition {
  readonly name: string;
  readonly schema: Document;
  readonly indexes?: readonly IndexDescription[];
  readonly validationLevel?: ValidationLevel;
  readonly validationAction?: ValidationAction;
}

/** Creates missing collections and updates existing ones; safe to run on every startup. */
export async function applyDefinitions(
  db: Db,
  definitions: readonly CollectionDefinition[],
): Promise<void> {
  const present = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  // One after another on purpose: fixed order, and the first refused validator stops the rest.
  /* eslint-disable no-await-in-loop */
  for (const definition of definitions) {
    const options = {
      validator: { $jsonSchema: definition.schema },
      validationLevel: definition.validationLevel ?? 'strict',
      validationAction: definition.validationAction ?? 'error',
    };

    if (present.has(definition.name)) {
      await db.command({ collMod: definition.name, ...options });
    } else {
      await db.createCollection(definition.name, options);
    }

    const collection = db.collection(definition.name);
    if (definition.indexes !== undefined && definition.indexes.length > 0) {
      await collection.createIndexes([...definition.indexes]);
    }

    // Drop indexes the definition no longer names, or an old one keeps refusing valid writes.
    const wanted = new Set((definition.indexes ?? []).map((index) => index.name));
    for (const existing of await collection.indexes()) {
      if (existing.name !== undefined && existing.name !== '_id_' && !wanted.has(existing.name)) {
        await collection.dropIndex(existing.name);
      }
    }
  }
  /* eslint-enable no-await-in-loop */
}
