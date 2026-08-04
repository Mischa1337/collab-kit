// Datenbankverbindung zu PostgreSQL.
// Exportiert den Connection-Pool (db) und eine Startfunktion (connectDB).
import { Pool } from 'pg';
import { logger } from './logger';
import { settings } from './settings';

// Pool = Sammlung von offenen Datenbankverbindungen, die wiederverwendet werden.
// Statt bei jeder Anfrage eine neue Verbindung aufzubauen (langsam),
// greift der Server auf eine bereits offene zurück (schnell).
// Verbindungsdaten kommen aus .env — Fallback-Werte greifen wenn eine Variable fehlt.
export const db = new Pool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'projekt5',
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  max: settings.db.poolMax, // Default 25 von 100 PostgreSQL-Verbindungen — lässt Raum für eine zweite Instanz
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Wird beim Serverstart aufgerufen (siehe index.ts) um zu prüfen ob die DB erreichbar ist.
// Holt kurz eine Verbindung aus dem Pool und gibt sie sofort wieder frei (release).
// Schlägt der Test fehl, startet der Server nicht.
export const connectDB = async (): Promise<void> => {
  const client = await db.connect();
  logger.info('PostgreSQL verbunden');
  client.release();
};
