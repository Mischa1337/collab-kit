import type { Db, Document, IndexDescription } from 'mongodb';

/** strict also checks updates of documents that already break the schema. */
export type ValidationLevel = 'off' | 'moderate' | 'strict';
/** warn only writes to the server log, error refuses the write. */
export type ValidationAction = 'warn' | 'error';

/**
 * One collection of the service: the $jsonSchema that MongoDB enforces, plus the
 * indexes that belong to it. This describes the bookkeeping of the service itself,
 * never the structure a docking tool brings along.
 */
export interface CollectionDefinition {
  readonly name: string;
  readonly schema: Document;
  readonly indexes?: readonly IndexDescription[];
  readonly validationLevel?: ValidationLevel;
  readonly validationAction?: ValidationAction;
}

/**
 * Creates missing collections with their validator and brings existing ones up to
 * date. Safe to run on every startup: nothing here depends on a previous state.
 */
export async function applyDefinitions(
  db: Db,
  definitions: readonly CollectionDefinition[],
): Promise<void> {
  const present = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  // Deliberately one after another: the order stays the same on every start, and the
  // first collection that refuses its validator stops the rest.
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

    // Indexes the definition no longer names are dropped. Without this an index from
    // an earlier field layout would keep refusing writes that the current one allows.
    const wanted = new Set((definition.indexes ?? []).map((index) => index.name));
    for (const existing of await collection.indexes()) {
      if (existing.name !== undefined && existing.name !== '_id_' && !wanted.has(existing.name)) {
        await collection.dropIndex(existing.name);
      }
    }
  }
  /* eslint-enable no-await-in-loop */
}
