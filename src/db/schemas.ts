import type { CollectionDefinition } from './apply.ts';

// While the field layout is still moving, every collection only warns instead of
// refusing. Switch validationAction to 'error' once the shapes have settled.
const whileDeveloping: Pick<CollectionDefinition, 'validationAction'> = {
  validationAction: 'warn',
};

const rooms: CollectionDefinition = {
  ...whileDeveloping,
  name: 'rooms',
  schema: {
    bsonType: 'object',
    required: ['name', 'createdAt', 'createdBy'],
    properties: {
      name: { bsonType: 'string' },
      settings: {
        bsonType: 'object',
        description: 'switch positions chosen by the docking tool, deliberately unconstrained',
      },
      contains: {
        bsonType: 'array',
        description: 'what the room bundles, pointed at and never owned',
        items: {
          bsonType: 'object',
          required: ['kind', 'id', 'addedAt', 'addedBy'],
          properties: {
            kind: {
              bsonType: 'string',
              description: 'document or group today, whatever docks later',
            },
            id: {},
            addedAt: { bsonType: 'date' },
            addedBy: { bsonType: 'string' },
          },
        },
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [{ key: { 'contains.id': 1 }, name: 'contains_id' }],
};

const groups: CollectionDefinition = {
  ...whileDeveloping,
  name: 'groups',
  schema: {
    bsonType: 'object',
    required: ['name', 'members', 'createdAt', 'createdBy'],
    properties: {
      name: { bsonType: 'string' },
      settings: {
        bsonType: 'object',
        description: 'what the group stands for in the docking tool, deliberately unconstrained',
      },
      members: {
        bsonType: 'array',
        description: 'opaque actor keys, no object and no task ever hangs on a group',
        items: {
          bsonType: 'object',
          required: ['actorId', 'joinedAt', 'addedBy'],
          properties: {
            actorId: { bsonType: 'string' },
            joinedAt: { bsonType: 'date' },
            addedBy: { bsonType: 'string' },
          },
        },
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [{ key: { 'members.actorId': 1 }, name: 'member_actor' }],
};

const actors: CollectionDefinition = {
  ...whileDeveloping,
  name: 'actors',
  schema: {
    bsonType: 'object',
    required: ['_id', 'firstSeenAt'],
    properties: {
      _id: {
        bsonType: 'string',
        description: 'the sub of the token, the service never issues a key of its own',
      },
      label: { bsonType: 'string' },
      firstSeenAt: { bsonType: 'date' },
      lastSeenAt: { bsonType: 'date' },
    },
  },
};

const documents: CollectionDefinition = {
  ...whileDeveloping,
  name: 'documents',
  schema: {
    bsonType: 'object',
    required: ['name', 'createdAt', 'createdBy'],
    properties: {
      name: { bsonType: 'string' },
      contract: {
        bsonType: 'object',
        description: 'what the tool registered while docking, deliberately unconstrained',
      },
      state: {
        bsonType: 'binData',
        description: 'folded Yjs state, a shortcut for loading, absent until first folded',
      },
      stateThrough: {
        bsonType: 'objectId',
        description: 'the last update folded into state, absent together with it',
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
      updatedAt: { bsonType: 'date', description: 'when it was folded last' },
    },
  },
};

const updates: CollectionDefinition = {
  ...whileDeveloping,
  name: 'updates',
  schema: {
    bsonType: 'object',
    required: ['documentId', 'update', 'actorId', 'createdAt'],
    properties: {
      documentId: { bsonType: 'objectId' },
      update: { bsonType: 'binData', description: 'the Yjs bytes, opaque to the service' },
      actorId: { bsonType: 'string', description: 'D6.19, author on every single change' },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { documentId: 1, _id: 1 }, name: 'document_stream' }],
};

export const collectionDefinitions: readonly CollectionDefinition[] = [
  actors,
  documents,
  groups,
  rooms,
  updates,
];
