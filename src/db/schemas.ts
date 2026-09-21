import type { Document } from 'mongodb';

import { anchorSchema, referenceSchema } from '../anchor.ts';
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
          ...referenceSchema,
          required: [...(referenceSchema['required'] as string[]), 'addedAt', 'addedBy'],
          properties: {
            ...(referenceSchema['properties'] as Document),
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

const comments: CollectionDefinition = {
  ...whileDeveloping,
  name: 'comments',
  schema: {
    bsonType: 'object',
    required: ['kind', 'anchor', 'actorId', 'body', 'createdAt'],
    properties: {
      kind: { bsonType: 'string', description: 'comment, feedback, message, reaction, ...' },
      anchor: anchorSchema,
      parentId: { bsonType: 'objectId', description: 'makes it an answer, D4.13' },
      actorId: { bsonType: 'string' },
      body: { bsonType: 'object', description: 'free, the service never reads it' },
      state: {
        bsonType: 'string',
        description: 'free, D8.20: open, read, answered, applied, rejected',
      },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [
    { key: { 'anchor.id': 1, _id: 1 }, name: 'anchor_id' },
    { key: { parentId: 1, _id: 1 }, name: 'parent_thread' },
    { key: { actorId: 1, _id: 1 }, name: 'actor_said' },
  ],
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

const events: CollectionDefinition = {
  ...whileDeveloping,
  name: 'events',
  schema: {
    bsonType: 'object',
    required: ['kind', 'actorId', 'anchor', 'createdAt'],
    properties: {
      kind: {
        bsonType: 'string',
        description: 'read, presence, visit, checkpoint, whatever the tool reports',
      },
      actorId: { bsonType: 'string' },
      anchor: anchorSchema,
      at: { bsonType: 'objectId', description: 'a place in the update stream' },
      label: { bsonType: 'string', description: 'only when a person named this moment' },
      reason: { bsonType: 'string', description: 'the why, D6.6, can only come from a person' },
      detail: { bsonType: 'object', description: 'free, the service never reads it' },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [
    { key: { 'anchor.id': 1, kind: 1, _id: -1 }, name: 'anchor_kind' },
    { key: { actorId: 1, kind: 1, _id: -1 }, name: 'actor_kind' },
  ],
};

const tasks: CollectionDefinition = {
  ...whileDeveloping,
  name: 'tasks',
  schema: {
    bsonType: 'object',
    required: ['kind', 'title', 'state', 'createdAt', 'createdBy'],
    properties: {
      kind: { bsonType: 'string', description: 'task, review, revision, approval, ...' },
      title: { bsonType: 'string' },
      state: {
        bsonType: 'string',
        description: 'free, the docking tool brings its own vocabulary',
      },
      anchor: anchorSchema,
      parentId: { bsonType: 'objectId', description: 'makes it a subtask' },
      subject: {
        bsonType: 'object',
        required: ['kind', 'id'],
        properties: { kind: { enum: ['actor', 'group'] }, id: {} },
      },
      order: { bsonType: 'number', description: 'order among siblings, D9.3' },
      detail: { bsonType: 'object', description: 'free, the service never reads it' },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
    },
  },
  indexes: [
    { key: { 'subject.id': 1, state: 1 }, name: 'subject_state' },
    { key: { 'anchor.id': 1 }, name: 'anchor_id' },
    { key: { parentId: 1, order: 1 }, name: 'parent_order' },
  ],
};

export const collectionDefinitions: readonly CollectionDefinition[] = [
  actors,
  comments,
  documents,
  events,
  groups,
  rooms,
  tasks,
  updates,
];
