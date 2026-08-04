// WP3 — Session-Chat (synchrone Begleitkommunikation, Heuristik H1).
// C5: zusätzlich persistent (Tabelle chat_messages) — Live-Broadcast + nachladbarer Verlauf.
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { broadcastToSession } from '../../utils/broadcast';
import { requireSessionMember, checkSessionOwner } from '../../middleware/authorization';
import { db } from '../../config/db';
import { logger } from '../../config/logger';
import { sendError } from '../../utils/http';
import { asyncHandler } from '../../utils/asyncHandler';
import { parsePagination } from '../../utils/pagination';

export const chatRoutes = Router();

/**
 * @route POST /api/sessions/:id/chat
 * @body  {string} content
 * @desc  Broadcastet ein `chat.message`-WS-Event UND persistiert die Nachricht.
 * @returns {200} gesendete Nachricht · {400} content fehlt · {403} kein Mitglied
 */
chatRoutes.post('/sessions/:id/chat', requireSessionMember, (req: Request, res: Response): void => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    sendError(res, 400, 'content ist ein Pflichtfeld');
    return;
  }

  // id vorab in Node erzeugen (statt DB-Default), damit Antwort + Broadcast sie sofort
  // tragen — nötig, damit das FE eine Nachricht referenzieren (z. B. löschen) kann.
  const message = {
    id: randomUUID(),
    session_id: id,
    user_id: req.user!.id,
    content: content.trim(),
    created_at: new Date().toISOString(),
  };

  // Persistenz best-effort (stört den Live-Chat nie). Promise.resolve macht es mock-/undefined-sicher.
  void Promise.resolve(
    db.query(`INSERT INTO chat_messages (id, session_id, user_id, content) VALUES ($1, $2, $3, $4)`, [message.id, id, message.user_id, message.content]),
  ).catch((err) => logger.error({ err, sessionId: id }, '[Chat] Persistenz Fehler'));

  broadcastToSession(id, { type: 'chat.message', payload: message });
  res.status(200).json(message);
});

/**
 * @route GET /api/sessions/:id/chat?limit=50&offset=0
 * @desc  Chat-Verlauf der Session (neueste zuerst).
 */
chatRoutes.get('/sessions/:id/chat', requireSessionMember, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { limit, offset } = parsePagination(req.query);
  const { rows } = await db.query(
    `SELECT id, session_id, user_id, content, created_at
     FROM chat_messages WHERE session_id = $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [req.params.id, limit, offset],
  );
  res.json(rows);
}));

/**
 * @route DELETE /api/chat/:messageId
 * @desc  Löscht eine Chat-Nachricht. Erlaubt für den Autor ODER den Session-Owner (Moderation).
 * @returns {204} gelöscht · {403} keine Berechtigung · {404} Nachricht nicht gefunden
 */
chatRoutes.delete('/chat/:messageId', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { messageId } = req.params;

  // Nachricht laden (user_id für die Rechteprüfung, session_id für den Broadcast).
  const { rows } = await db.query(
    `SELECT user_id, session_id FROM chat_messages WHERE id = $1`,
    [messageId],
  );
  if (rows.length === 0) {
    sendError(res, 404, 'Nachricht nicht gefunden');
    return;
  }

  const { user_id, session_id } = rows[0];
  // Autor darf immer; sonst nur der Session-Owner.
  if (user_id !== req.user!.id && !(await checkSessionOwner(req.user!.id, session_id))) {
    sendError(res, 403, 'Keine Berechtigung zum Löschen der Nachricht');
    return;
  }

  await db.query(`DELETE FROM chat_messages WHERE id = $1`, [messageId]);
  broadcastToSession(session_id, { type: 'chat.deleted', payload: { id: messageId } });
  res.status(204).send();
}));
