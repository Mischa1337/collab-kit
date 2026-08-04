// Punkt 3 — Nachlesbarer Change-Feed: Lese-Endpunkt (rein additiv).
import { Router, Request, Response } from 'express';
import { getChanges, getLastVisit, setChangeWhy } from './changelog.service';
import { requireSessionMember } from '../../middleware/authorization';
import { sendError } from '../../utils/http';
import { asyncHandler } from '../../utils/asyncHandler';
import { parsePagination } from '../../utils/pagination';

export const changelogRoutes = Router();

// N1: nur Mitglieder der Session dürfen den Change-Feed lesen.

/**
 * @route GET /api/sessions/:id/changes
 * @query {string} [since]            — nur Änderungen nach diesem ISO-Zeitpunkt
 * @query {bool}   [since_last_visit] — statt `since` den letzten Besuch des Nutzers verwenden
 * @query {int}    [limit=50] [offset=0]
 * @desc  Persistente Schicht-2-Änderungen (ChangeRecord-Form), neueste zuerst.
 */
changelogRoutes.get('/sessions/:id/changes', requireSessionMember, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { limit, offset } = parsePagination(req.query);
  if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
    sendError(res, 400, 'limit/offset müssen Zahlen sein');
    return;
  }

  let since = typeof req.query.since === 'string' ? req.query.since : undefined;
  if (req.query.since_last_visit === 'true') {
    since = (await getLastVisit(id, req.user!.id)) ?? undefined;
  }

  res.json(await getChanges(id, { since, limit, offset }));
}));

/**
 * @route PATCH /api/sessions/:id/changes/:cid/why
 * @body  { kind: 'comment'|'review', refId: UUID }
 * @desc  A3 — eine Änderung/einen Konflikt mit einer Begründungsquelle verknüpfen.
 */
changelogRoutes.patch('/sessions/:id/changes/:cid/why', requireSessionMember, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id, cid } = req.params;
  const { kind, refId } = req.body;
  if ((kind !== 'comment' && kind !== 'review') || !refId || typeof refId !== 'string') {
    sendError(res, 400, "kind muss 'comment' oder 'review' sein und refId gesetzt");
    return;
  }
  const updated = await setChangeWhy(id, cid, kind, refId);
  if (!updated) {
    sendError(res, 404, 'Änderungseintrag nicht gefunden');
    return;
  }
  res.json(updated);
}));
