// Express-App-Konfiguration: Middleware-Kette und Routen.
// Bewusst getrennt von index.ts, damit Tests (Jest/supertest) die App direkt importieren können
// ohne einen echten Server zu starten.
import 'dotenv/config'; // lädt .env-Datei als erstes, damit alle Umgebungsvariablen verfügbar sind
import path from 'path';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { logger } from './config/logger';
import { settings } from './config/settings';

import { sessionRoutes } from './services/sessions/routes';
import { historyRoutes } from './services/history/routes';
import { commentRoutes } from './services/comments/routes';
import { reviewRoutes } from './services/reviews/routes';
import { notificationRoutes } from './services/notifications/routes';
import { exportRoutes } from './services/export/routes';
import { chatRoutes } from './services/chat/routes';
import { changelogRoutes } from './services/changelog/routes';
import { taskRoutes } from './services/tasks/routes';
import { draftRoutes } from './services/drafts/routes';
import { healthRoutes } from './services/health/routes';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { httpMetrics } from './middleware/httpMetrics';

export const app = express();

// ── Statische Dev-UIs (nur in Entwicklung) ───────────────────────────────────
// /ui/ → Test-UI (volltest.html);  / → public/ (M10 SQL-Playground, z. B. playground.html).
// Im Dev ist Helmets CSP ohnehin aus (siehe helmet() unten), daher laden externe
// ESM-Imports von https://esm.sh/. In Produktion werden diese Routen nicht registriert.
if (process.env.NODE_ENV !== 'production') {
  app.use('/ui', express.static(path.join(__dirname, '../test')));
  app.use(express.static(path.join(__dirname, '..', 'public')));
}

// ── Middleware ────────────────────────────────────────────────────────────────
// Middleware läuft bei JEDER Anfrage in dieser Reihenfolge durch, bevor die Route antwortet.

// Sicherheits-Header: X-Frame-Options, X-Content-Type-Options, HSTS u.a.
// Muss als erstes stehen damit alle Antworten — auch Fehler — die Header tragen.
// M10: CSP nur im Dev abschalten, damit der SQL-Playground externe ESM-Imports
// (esm.sh) laden kann. In Produktion bleibt die volle Helmet-CSP aktiv.
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
}));

// CORS: erlaubt Anfragen aus dem Browser (andere Domain/Port).
// Ohne diesen Header blockiert der Browser die Antwort aus Sicherheitsgründen.
// QUAL-7: In Produktion muss CORS_ORIGIN explizit gesetzt sein — kein stilles Wildcard-Fallback.
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  throw new Error('CORS_ORIGIN muss in Produktion gesetzt sein (z.B. https://meine-hochschule.de)');
}
app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));

// N2: In Produktion MUSS ein Auth-Dienst angebunden sein — sonst liefe die API ungeschützt
// (authMiddleware würde ohne AUTH_SERVICE_URL alle Anfragen als dev-user durchwinken).
// Fail-fast statt still offen — analog zur CORS-Prüfung oben.
if (process.env.NODE_ENV === 'production' && !process.env.AUTH_SERVICE_URL) {
  throw new Error('AUTH_SERVICE_URL muss in Produktion gesetzt sein — sonst ist die API unauthentifiziert');
}

// Parst den Request-Body als JSON — ohne das ist req.body immer undefined.
// Limit: 1MB — ausreichend für alle normalen Aktionen, verhindert übermäßig große Requests.
app.use(express.json({ limit: settings.http.bodyLimit }));

// Loggt jede HTTP-Anfrage strukturiert (JSON in Prod, lesbar in Dev).
app.use(pinoHttp({ logger }));

// Misst die Antwortzeit jedes Requests für Prometheus.
app.use(httpMetrics);

// ── Öffentliche Routen (ohne Auth) ───────────────────────────────────────────

// Health/Readiness/Metrics: ohne Auth, vor Rate Limiting
app.use(healthRoutes);

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// Begrenzt REST-API-Anfragen auf 200 pro 15 Minuten pro IP.
// WebSocket-Traffic (Tippen, Sync) zählt nicht — nur explizite HTTP-Calls.
const apiLimiter = rateLimit({
  windowMs: settings.http.rateLimitWindowMs,
  max: settings.http.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Zu viele Anfragen — bitte in 15 Minuten erneut versuchen.', status: 429 } },
});

// ── Geschützte API-Routen (mit Auth) ─────────────────────────────────────────

// authMiddleware läuft vor ALLEN /api-Routen — zentrale Authentifizierung an einer Stelle.
// Jede Route darunter kann davon ausgehen, dass req.user gesetzt ist.
app.use('/api', apiLimiter);
app.use('/api', authMiddleware);
app.use('/api/sessions', sessionRoutes);
app.use('/api', historyRoutes);
app.use('/api', commentRoutes);
app.use('/api', reviewRoutes);
app.use('/api', notificationRoutes);
app.use('/api', exportRoutes);
app.use('/api', chatRoutes);
app.use('/api', changelogRoutes);
app.use('/api', taskRoutes);
app.use('/api', draftRoutes);

// ── Fehlerbehandlung ──────────────────────────────────────────────────────────

// 404-Handler: greift wenn keine der obigen Routen gepasst hat.
// Muss NACH allen Routen stehen, sonst würde er Anfragen abfangen bevor die Routen sie sehen.
app.use((_req, res) => {
  res.status(404).json({ error: { message: 'Route nicht gefunden', status: 404 } });
});

// Zentraler Error-Handler: fängt alle Fehler auf die in Routen mit next(err) weitergegeben werden.
// Muss als LETZTES stehen — Express erkennt Error-Handler an den genau 4 Parametern (err, req, res, next).
app.use(errorHandler);
