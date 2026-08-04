// Einstiegspunkt des Servers — wird als erstes ausgeführt wenn "npm run dev" gestartet wird.
// Zuständig für: Datenbankverbindungen aufbauen, WebSocket einrichten, Server starten.
// Die Express-App selbst (Middleware, Routen) ist in app.ts definiert.
import { createServer } from 'http';
import { app } from './app';
import { connectDB, db } from './config/db';
import { connectRedis, redis } from './config/redis';
import { closeWebSocketServer, setupWebSocketServer } from './services/websocket/controller';
import { logger } from './config/logger';

// Express allein kann keine WebSockets — deshalb wird die App in einen HTTP-Server eingebettet.
// Beide (REST und WebSocket) laufen dann auf demselben Port.
const httpServer = createServer(app);

// Port aus der .env-Datei lesen, Fallback auf 3000 wenn nicht gesetzt.
const PORT = process.env.PORT ?? 3000;

// WebSocket-Server muss vor httpServer.listen() eingerichtet werden,
// damit er bereit ist sobald der erste Client eine Verbindung aufbaut.
setupWebSocketServer(httpServer);

// Startet die Verbindungen und den Server in der richtigen Reihenfolge.
// async/await stellt sicher, dass DB und Redis wirklich verbunden sind bevor der Server Anfragen annimmt.
async function start() {
  await connectDB();
  await connectRedis();

  httpServer.listen(PORT, () => {
    logger.info({ port: PORT }, 'Server gestartet');
  });
}

// Wenn der Start fehlschlägt (z.B. DB nicht erreichbar), Fehler ausgeben und Prozess beenden.
// process.exit(1) signalisiert dem Betriebssystem, dass das Programm mit einem Fehler endete.
start().catch(err => {
  logger.error({ err }, 'Server konnte nicht starten');
  process.exit(1);
});

// Geordnetes Herunterfahren bei SIGTERM (Docker-Stop) und SIGINT (Ctrl+C).
// Reihenfolge: (1) WS-Verbindungen schließen → (2) HTTP-Server stoppen → (3) DB + Redis trennen.
// httpServer.close() allein reicht nicht — lang-lebige WS-Verbindungen blockieren den Callback.
// Timeout-Fallback: nach 10s erzwungener Exit, falls eine Ressource nicht antworten.
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, '[Shutdown] Server wird heruntergefahren');

  // Erzwungener Exit nach 10 Sekunden, falls der Shutdown hängt
  const forceExit = setTimeout(() => {
    logger.error('[Shutdown] Timeout — erzwungener Exit nach 10s');
    process.exit(1);
  }, 10_000);
  forceExit.unref(); // Verhindert dass der Timer den Prozess am Leben hält

  try {
    await closeWebSocketServer();

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    logger.info('[Shutdown] HTTP-Server gestoppt');

    await db.end();
    logger.info('[Shutdown] PostgreSQL-Pool geschlossen');
    await redis.quit();
    logger.info('[Shutdown] Redis-Verbindung geschlossen');

    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, '[Shutdown] Fehler beim Schließen');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT')); 