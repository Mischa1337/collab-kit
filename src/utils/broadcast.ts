// Zentraler WS-Broadcast über Redis Pub/Sub — hierher gezogen aus websocket/controller.ts,
// damit Services (comments, tasks, chat, drafts, history, reviews) nicht das gesamte
// WS-Controller-Modul (y-websocket, Server-State) importieren müssen, nur um ein Event zu senden.
import { redis } from '../config/redis';
import { logger } from '../config/logger';

export function broadcastToSession(sessionId: string, data: unknown): void {
  redis.publish(`session:${sessionId}:events`, JSON.stringify(data))
    .catch((err) => logger.error({ err, sessionId }, '[Pub/Sub] Publish Fehler'));
}
