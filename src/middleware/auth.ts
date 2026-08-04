import { Request, Response, NextFunction } from 'express';
import { AuthUser } from '../types/auth';

// ── Adapter ──────────────────────────────────────────────────────────────────
// Einzige Stelle die angepasst werden muss, sobald Projekt 1 ihr Response-Format nennt.
// Gehärtet gegen die häufigsten Abweichungen:
//   • verschachteltes Nutzerobjekt ({ user: {...} } / { data: {...} } / { principal: {...} })
//   • „ungültig trotz HTTP 200"-Signal ({ valid:false } / { active:false }, z.B. RFC-7662-Introspection)
//   • abweichende Feldnamen — optional per Env AUTH_FIELD_ID / AUTH_FIELD_NAME überschreibbar
function firstString(obj: Record<string, unknown>, candidates: (string | undefined)[]): string | undefined {
  for (const key of candidates) {
    if (!key) continue;
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).length > 0) return String(value);
  }
  return undefined;
}

function mapToAuthUser(raw: unknown): AuthUser | null {
  if (!raw || typeof raw !== 'object') return null;
  let r = raw as Record<string, unknown>;

  // Manche Dienste verschachteln den Nutzer eine Ebene tiefer — flach ziehen (äußere Felder haben Vorrang).
  const nested = (r.user ?? r.data ?? r.principal) as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object') r = { ...nested, ...r };

  // Explizites Ungültig-Signal trotz HTTP 200.
  if (r.valid === false || r.active === false) return null;

  const id = firstString(r, [process.env.AUTH_FIELD_ID, 'userId', 'sub', 'id', 'uid', 'user_id']);
  if (!id) return null; // ohne auflösbare Identität gilt der Token als ungültig
  const name = firstString(r, [process.env.AUTH_FIELD_NAME, 'name', 'displayName', 'username', 'preferred_username']) ?? 'Unbekannt';
  return { id, name };
}

// Validiert einen Token gegen AUTH_SERVICE_URL.
// Gibt null zurück wenn der Token ungültig oder abgelaufen ist.
export async function validateToken(token: string, serviceUrl: string): Promise<AuthUser | null> {
  try {
    const response = await fetch(serviceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Token zusätzlich als Bearer mitsenden — viele Introspection-/Validierungs-Endpoints
        // erwarten ihn im Authorization-Header statt (oder zusätzlich zu) im Body.
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000), // max 3s — danach 401 statt ewig hängen
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null); // tolerant gegen nicht-JSON-Antworten
    return mapToAuthUser(data);
  } catch {
    return null;
  }
}

const DEV_USER: AuthUser = { id: 'dev-user', name: 'Dev User' };

// ── Middleware ────────────────────────────────────────────────────────────────
// Ohne AUTH_SERVICE_URL (Entwicklung/Test): Fallback-Nutzer, keine 401.
// Mit AUTH_SERVICE_URL (Produktion): Bearer-Token aus Authorization-Header validieren.
export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const serviceUrl = process.env.AUTH_SERVICE_URL;

  if (!serviceUrl) {
    // Dev-only: erlaubt lokal mehrere unterscheidbare Test-Identitäten zu simulieren
    // (z.B. für echtes Multi-Rollen-Testen), ohne dass ein echter Auth-Service läuft.
    // Ohne Header identisches Verhalten wie zuvor (immer DEV_USER). Greift NIE wenn
    // AUTH_SERVICE_URL gesetzt ist (Produktion), da dieser Zweig dann gar nicht läuft.
    const devUserId = req.header('X-Dev-User-Id');
    req.user = devUserId ? { id: devUserId, name: devUserId } : DEV_USER;
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { message: 'Kein Token angegeben', status: 401 } });
    return;
  }

  const token = authHeader.slice(7);
  const user = await validateToken(token, serviceUrl);

  if (!user) {
    res.status(401).json({ error: { message: 'Ungültiger oder abgelaufener Token', status: 401 } });
    return;
  }

  req.user = user;
  next();
};

