import { Router } from 'express';
import client from 'prom-client';
import { db } from '../../config/db';
import { redis } from '../../config/redis';
import { getActiveSessionCount, getActiveWsConnectionCount } from '../websocket/controller';

export const healthRoutes = Router();

// Standard-Metriken: CPU, Memory, Event-Loop-Lag etc.
client.collectDefaultMetrics();

const activeSessions = new client.Gauge({
  name: 'coworking_active_sessions',
  help: 'Anzahl aktiver Sessions mit mindestens einer WS-Verbindung',
});

const wsConnections = new client.Gauge({
  name: 'coworking_ws_connections',
  help: 'Anzahl offener WebSocket-Verbindungen',
});

const dbPoolTotal = new client.Gauge({
  name: 'coworking_db_pool_total',
  help: 'Gesamte Verbindungen im DB-Pool',
});

const dbPoolIdle = new client.Gauge({
  name: 'coworking_db_pool_idle',
  help: 'Idle-Verbindungen im DB-Pool',
});

const dbPoolWaiting = new client.Gauge({
  name: 'coworking_db_pool_waiting',
  help: 'Wartende Anfragen im DB-Pool',
});

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP Request-Latenz in Sekunden',
  labelNames: ['route', 'method', 'status'] as const,
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

export { httpDuration };

// Liveness: Prozess läuft — keine Abhängigkeiten geprüft
healthRoutes.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness: DB und Redis müssen erreichbar sein
healthRoutes.get('/ready', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
});

// Metriken für Prometheus/Grafana — geschützt (M19/M20-Abgleich):
//  • METRICS_TOKEN gesetzt (Produktion): Bearer-Token (oder ?token=) muss passen — unabhängig von Gruppe 1.
//  • sonst (Entwicklung): nur von localhost erreichbar.
// Zusätzlich sperrt der Reverse-Proxy /metrics extern (Defense-in-Depth, siehe deploy/nginx.conf).
healthRoutes.get('/metrics', async (req, res) => {
  const expectedToken = process.env.METRICS_TOKEN;
  if (expectedToken) {
    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
    if (provided !== expectedToken) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  } else {
    const ip = req.ip ?? '';
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  }
  activeSessions.set(getActiveSessionCount());
  wsConnections.set(getActiveWsConnectionCount());
  dbPoolTotal.set(db.totalCount);
  dbPoolIdle.set(db.idleCount);
  dbPoolWaiting.set(db.waitingCount);

  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});
