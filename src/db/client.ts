import { MongoClient, type Db } from 'mongodb';

export interface Storage {
  readonly client: MongoClient;
  readonly db: Db;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Full connection string. The service never assembles a host of its own. */
  readonly uri: string;
  readonly database: string;
  readonly serverSelectionTimeoutMs?: number;
}

/**
 * Opens the single connection pool of the process and proves it works with a ping,
 * so a wrong address fails at startup and not on the first request.
 */
export async function connect(options: ConnectOptions): Promise<Storage> {
  const client = new MongoClient(options.uri, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 5_000,
  });

  try {
    await client.connect();
    const db = client.db(options.database);
    await db.command({ ping: 1 });

    return {
      client,
      db,
      close: async () => {
        await client.close();
      },
    };
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw new Error(`cannot reach the database "${options.database}"`, { cause });
  }
}
