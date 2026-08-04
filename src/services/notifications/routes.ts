// M17 — Notification-REST-API: jeder Nutzer sieht und verwaltet NUR seine eigenen Benachrichtigungen.
// req.user wird von authMiddleware gesetzt.
import { Request, Response, Router } from 'express';
import { sendError } from '../../utils/http';
import { logger } from '../../config/logger';
import { buildDigest, countUnread, getSinceLastVisit, listNotifications, markAllRead, markNotificationRead, markSessionSeen } from './notification.service';
import { requireSessionMember } from '../../middleware/authorization';

export const notificationRoutes = Router();

/**
 * @route   GET /api/notifications
 * @query   {string} [unread] "true" → nur ungelesene
 * @returns {200} Array der eigenen Benachrichtigungen (neueste zuerst)
 */
notificationRoutes.get('/notifications', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    const rows = await listNotifications(userId, { unreadOnly: req.query.unread === 'true' });
    res.json(rows);
  } catch (err) {
    logger.error({ err, userId }, '[Notifications] Abrufen fehlgeschlagen');
    sendError(res, 500, 'Benachrichtigungen konnten nicht abgerufen werden');
  }
});

/**
 * @route   GET /api/notifications/unread-count
 * @returns {200} { count } — Anzahl ungelesener Benachrichtigungen
 */
notificationRoutes.get('/notifications/unread-count', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    res.json({ count: await countUnread(userId) });
  } catch (err) {
    logger.error({ err, userId }, '[Notifications] Zähler fehlgeschlagen');
    sendError(res, 500, 'Zähler konnte nicht ermittelt werden');
  }
});

/**
 * @route   POST /api/notifications/:id/read
 * @desc    Eine eigene Benachrichtigung als gelesen markieren
 * @returns {200} aktualisierte Benachrichtigung | {404} nicht gefunden / nicht eigen / schon gelesen
 */
notificationRoutes.post('/notifications/:id/read', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    const updated = await markNotificationRead(req.params.id, userId);
    if (!updated) {
      sendError(res, 404, 'Benachrichtigung nicht gefunden');
      return;
    }
    res.json(updated);
  } catch (err) {
    logger.error({ err, userId }, '[Notifications] Als gelesen markieren fehlgeschlagen');
    sendError(res, 500, 'Benachrichtigung konnte nicht aktualisiert werden');
  }
});

/**
 * @route   POST /api/notifications/read-all
 * @desc    Alle eigenen ungelesenen Benachrichtigungen als gelesen markieren
 * @returns {200} { updated } — Anzahl aktualisierter Benachrichtigungen
 */
notificationRoutes.post('/notifications/read-all', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    res.json({ updated: await markAllRead(userId) });
  } catch (err) {
    logger.error({ err, userId }, '[Notifications] Alle als gelesen markieren fehlgeschlagen');
    sendError(res, 500, 'Benachrichtigungen konnten nicht aktualisiert werden');
  }
});

/**
 * @route   POST /api/sessions/:id/seen
 * @desc    Markiert die Session als "jetzt gesehen" (Basis für "seit deinem letzten Besuch").
 * @returns {204} ok | {404} Session nicht gefunden
 */
notificationRoutes.post('/sessions/:id/seen', requireSessionMember, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    await markSessionSeen(userId, req.params.id);
    res.status(204).send();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23503') {
      sendError(res, 404, 'Session nicht gefunden');
      return;
    }
    logger.error({ err, userId }, '[Notifications] markSessionSeen fehlgeschlagen');
    sendError(res, 500, 'Konnte nicht als gesehen markiert werden');
  }
});

/**
 * @route   GET /api/sessions/:id/since-last-visit
 * @desc    Zähler dessen, was seit dem letzten Besuch von anderen passiert ist.
 * @returns {200} { last_seen_at, new_comments, new_versions, new_reviews }
 */
notificationRoutes.get('/sessions/:id/since-last-visit', requireSessionMember, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    res.json(await getSinceLastVisit(userId, req.params.id));
  } catch (err) {
    logger.error({ err, userId }, '[Notifications] since-last-visit fehlgeschlagen');
    sendError(res, 500, 'Zähler konnte nicht ermittelt werden');
  }
});

/**
 * @route   GET /api/notifications/digest
 * @desc    Vorschau des eigenen Digests (Zusammenfassung ungelesener Benachrichtigungen).
 *          E-Mail-Versand ist eine separate Aktivierung (SMTP/Cron) (nicht Teil dieses Repositories).
 * @returns {200} { count, subject, lines }
 */
notificationRoutes.get('/notifications/digest', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    res.json(await buildDigest(userId));
  } catch (err) {
    logger.error({ err, userId }, '[Notifications] digest fehlgeschlagen');
    sendError(res, 500, 'Digest konnte nicht erstellt werden');
  }
});
