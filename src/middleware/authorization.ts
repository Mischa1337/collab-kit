import { Request, Response, NextFunction, RequestHandler } from 'express';
import { db } from '../config/db';
import type { SessionRole } from '../types/roles';

// N1 — Autorisierung: eine SQL-Quelle (getSessionRole, s. u.).
// Mitgliedschaft und Owner-Status werden aus der Rolle abgeleitet — kein
// separater session_members-Lookup mehr. Dev-Modus (kein AUTH_SERVICE_URL):
// getSessionRole liefert 'owner' → beide Prüfungen true (kein Block).

export async function checkSessionMembership(userId: string, sessionId: string): Promise<boolean> {
  return (await getSessionRole(userId, sessionId)) !== null;
}

export async function checkSessionOwner(userId: string, sessionId: string): Promise<boolean> {
  return (await getSessionRole(userId, sessionId)) === 'owner';
}

// Middleware für Routen wo req.params.id die Session-UUID ist.
export const requireSessionMember: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!await checkSessionMembership(req.user!.id, req.params.id)) {
      res.status(403).json({ error: { message: 'Kein Mitglied dieser Session', status: 403 } });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
};

// ── Abgestufte Rollen — der Typ liegt zentral in types/roles.ts und wird hier
// re-exportiert, damit bestehende Importe aus diesem Modul weiter funktionieren. ──
export type { SessionRole };

// Dev-Modus (kein AUTH_SERVICE_URL) prüft normalerweise nicht wirklich — 'owner' für alle (volle Rechte).
// Opt-in DEV_ENFORCE_ROLES=true schaltet das für lokales Multi-Rollen-Testen ab (z.B. Konflikt-Dialog
// mit echten owner/member-Accounts): dann zählt die echte session_members-Tabelle, wie in Produktion.
export const devEnforcesRoles = () => process.env.DEV_ENFORCE_ROLES === 'true';

// Rolle des Nutzers in der Session (oder null). Dev-Modus (kein AUTH_SERVICE_URL): 'owner' (volle Rechte),
// außer DEV_ENFORCE_ROLES=true ist gesetzt.
export async function getSessionRole(userId: string, sessionId: string): Promise<SessionRole | null> {
  if (!process.env.AUTH_SERVICE_URL && !devEnforcesRoles()) return 'owner';
  const { rows } = await db.query(
    'SELECT role FROM session_members WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  return (rows[0]?.role as SessionRole) ?? null;
}

// Rechte-Helfer = eine Quelle der Wahrheit für die Berechtigungsmatrix.
export const canEditModel = (role: SessionRole | null): boolean => role === 'owner' || role === 'member';
// Peer Review: NUR owner/member nehmen teil.
export const canReview = (role: SessionRole | null): boolean => role === 'owner' || role === 'member';
// Kommentieren (allgemeine Kommentare): owner/member/commentator.
export const canComment = (role: SessionRole | null): boolean =>
  role === 'owner' || role === 'member' || role === 'commentator';
// Kommentare SEHEN: owner/member/commentator (spectator NICHT).
export const canSeeComments = (role: SessionRole | null): boolean =>
  role === 'owner' || role === 'member' || role === 'commentator';
// Team-intern (interne Kommentare): nur das Team, NICHT commentator/spectator.
export const canSeeInternal = (role: SessionRole | null): boolean =>
  role === 'owner' || role === 'member';

// Middleware-Fabrik: nur die genannten Rollen, sonst 403. Dev-Modus: durchlassen.
// Setzt voraus, dass req.params.id die Session-UUID ist.
export function requireRole(...allowed: SessionRole[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!process.env.AUTH_SERVICE_URL && !devEnforcesRoles()) { next(); return; }
      const role = await getSessionRole(req.user!.id, req.params.id);
      if (!role) {
        res.status(403).json({ error: { message: 'Kein Mitglied dieser Session', status: 403 } });
        return;
      }
      if (!allowed.includes(role)) {
        res.status(403).json({ error: { message: 'Rolle nicht ausreichend für diese Aktion', status: 403 } });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Bequeme Vorkonfigurationen für die häufigen Fälle.
export const requireModelEditor: RequestHandler = requireRole('owner', 'member');                 // Modell ändern
export const requireComment: RequestHandler = requireRole('owner', 'member', 'commentator');      // Kommentar schreiben
export const requireReview: RequestHandler = requireRole('owner', 'member');                      // Peer Review

// Wie requireComment/requireReview, aber für Routen, deren Session-ID erst zur Laufzeit
// aufgelöst wird (z. B. aus einem Kommentar/Review statt aus req.params.id) — dort greift
// die params-basierte Middleware nicht. Antworten bei fehlender Berechtigung selbst mit 403.

// Kommentar-Aktion (owner/member/commentator).
export async function ensureCommenter(userId: string, sessionId: string, res: Response): Promise<boolean> {
  if (canComment(await getSessionRole(userId, sessionId))) return true;
  res.status(403).json({ error: { message: 'Keine Berechtigung (Rolle) für diese Aktion', status: 403 } });
  return false;
}

// Peer-Review-Aktion (nur owner/member).
export async function ensureReviewer(userId: string, sessionId: string, res: Response): Promise<boolean> {
  if (canReview(await getSessionRole(userId, sessionId))) return true;
  res.status(403).json({ error: { message: 'Nur owner/member dürfen an Peer Reviews teilnehmen', status: 403 } });
  return false;
}

// Wie requireModelEditor (owner/member), aber für Routen mit erst zur Laufzeit
// aufgelöster Session-ID. Antwortet bei fehlender Berechtigung selbst mit 403, sonst true.
export async function ensureModelEditor(userId: string, sessionId: string, res: Response): Promise<boolean> {
  if (canEditModel(await getSessionRole(userId, sessionId))) return true;
  res.status(403).json({ error: { message: 'Keine Berechtigung (Rolle) für diese Aktion', status: 403 } });
  return false;
}
