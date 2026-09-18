import { ObjectId, type Db, type Document } from 'mongodb';

/** "Actor X holds role R within scope G." The scope is free on purpose. */
export interface Grant {
  scope: { kind: string; id: unknown };
  subject: { kind: 'actor' | 'group'; id: unknown };
  role: string;
  grantedAt: Date;
  grantedBy: string;
}

export interface Room {
  _id: ObjectId;
  name: string;
  /** Switch positions of the docking tool. The service never reads them. */
  settings: Document;
  grants: Grant[];
  createdAt: Date;
  createdBy: string;
}

export interface NewRoom {
  readonly name: string;
  readonly createdBy: string;
  readonly settings?: Document;
  readonly grants?: readonly Grant[];
}

export async function createRoom(db: Db, input: NewRoom): Promise<Room> {
  const room: Room = {
    _id: new ObjectId(),
    name: input.name,
    settings: input.settings ?? {},
    grants: [...(input.grants ?? [])],
    createdAt: new Date(),
    createdBy: input.createdBy,
  };

  await db.collection<Room>('rooms').insertOne(room);
  return room;
}

export async function findRoom(db: Db, id: ObjectId): Promise<Room | null> {
  return db.collection<Room>('rooms').findOne({ _id: id });
}
