// M12 — Auth-Middleware Tests
// Prüft alle drei Pfade: Fallback-Modus, Produktions-Modus (mit AUTH_SERVICE_URL) und den Adapter.
// fetch wird gemockt — kein echter HTTP-Request zu Projekt 1 nötig.
import { Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function makeReq(headers: Record<string, string> = {}): Request {
  // header() liest case-insensitiv wie Express' echtes Request.header() — die Middleware nutzt
  // das jetzt für den optionalen X-Dev-User-Id-Header (Multi-Identität im Fallback-Modus).
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers,
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

function mockFetchOk(body: object): void {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200 })
  );
}

function mockFetchFail(status = 401): void {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response(null, { status })
  );
}

// AUTH_SERVICE_URL zwischen Tests isolieren
const ORIGINAL_ENV = process.env;
beforeEach(() => { process.env = { ...ORIGINAL_ENV }; });
afterEach(() => { process.env = ORIGINAL_ENV; jest.restoreAllMocks(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('M12 — Auth-Middleware', () => {

  describe('Fallback-Modus (AUTH_SERVICE_URL nicht gesetzt)', () => {
    it('ruft next() auf ohne 401 zu senden', async () => {
      delete process.env.AUTH_SERVICE_URL;
      const req  = makeReq();
      const res  = makeRes();
      const next = jest.fn() as NextFunction;

      await authMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('setzt req.user auf den Fallback-Nutzer', async () => {
      delete process.env.AUTH_SERVICE_URL;
      const req  = makeReq();
      const res  = makeRes();
      const next = jest.fn() as NextFunction;

      await authMiddleware(req, res, next);

      expect(req.user).toEqual({ id: 'dev-user', name: 'Dev User' });
    });
  });

  describe('Produktions-Modus (AUTH_SERVICE_URL gesetzt)', () => {
    beforeEach(() => {
      process.env.AUTH_SERVICE_URL = 'http://projekt1/auth/validate';
    });

    // Abnahmekriterium M12 #1: Ohne gültigen Token kein Zugriff.
    it('gibt 401 zurück wenn kein Authorization-Header vorhanden ist', async () => {
      const req  = makeReq();
      const res  = makeRes();
      const next = jest.fn() as NextFunction;

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('gibt 401 zurück wenn der Header kein Bearer-Token ist', async () => {
      const req  = makeReq({ authorization: 'Basic dXNlcjpwYXNz' });
      const res  = makeRes();
      const next = jest.fn() as NextFunction;

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    // Abnahmekriterium M12 #4: Abgelaufene / ungültige Tokens werden abgelehnt.
    it('gibt 401 zurück wenn Projekt 1 den Token ablehnt', async () => {
      mockFetchFail(401);
      const req  = makeReq({ authorization: 'Bearer abgelaufen-oder-falsch' });
      const res  = makeRes();
      const next = jest.fn() as NextFunction;

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('gibt 401 zurück wenn Projekt 1 nicht erreichbar ist (Netzwerkfehler)', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const req  = makeReq({ authorization: 'Bearer irgendein-token' });
      const res  = makeRes();
      const next = jest.fn() as NextFunction;

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    // Abnahmekriterium M12 #2: Nutzer-ID aus Token wird korrekt übernommen.
    it('setzt req.user korrekt wenn der Token gültig ist', async () => {
      mockFetchOk({ userId: 'user-42', name: 'Max Mustermann' });
      const req  = makeReq({ authorization: 'Bearer gueltig' });
      const res  = makeRes();
      const next = jest.fn() as NextFunction;

      await authMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({ id: 'user-42', name: 'Max Mustermann' });
    });
  });

  describe('Adapter — Feldnamen-Flexibilität', () => {
    beforeEach(() => {
      process.env.AUTH_SERVICE_URL = 'http://projekt1/auth/validate';
    });

    it('erkennt userId als User-ID', async () => {
      mockFetchOk({ userId: 'u1', name: 'Alice' });
      const req = makeReq({ authorization: 'Bearer x' });
      await authMiddleware(req, makeRes(), jest.fn() as NextFunction);
      expect(req.user?.id).toBe('u1');
    });

    it('erkennt sub als User-ID (JWT-Standard)', async () => {
      mockFetchOk({ sub: 'u2', name: 'Bob' });
      const req = makeReq({ authorization: 'Bearer x' });
      await authMiddleware(req, makeRes(), jest.fn() as NextFunction);
      expect(req.user?.id).toBe('u2');
    });

    it('erkennt id als User-ID (generischer Fallback)', async () => {
      mockFetchOk({ id: 'u3', name: 'Charlie' });
      const req = makeReq({ authorization: 'Bearer x' });
      await authMiddleware(req, makeRes(), jest.fn() as NextFunction);
      expect(req.user?.id).toBe('u3');
    });

    it('erkennt displayName als Anzeigename', async () => {
      mockFetchOk({ sub: 'u4', displayName: 'Diana' });
      const req = makeReq({ authorization: 'Bearer x' });
      await authMiddleware(req, makeRes(), jest.fn() as NextFunction);
      expect(req.user?.name).toBe('Diana');
    });

    it('erkennt username als Anzeigename', async () => {
      mockFetchOk({ sub: 'u5', username: 'eva99' });
      const req = makeReq({ authorization: 'Bearer x' });
      await authMiddleware(req, makeRes(), jest.fn() as NextFunction);
      expect(req.user?.name).toBe('eva99');
    });

    // userId hat Vorrang vor sub hat Vorrang vor id — Reihenfolge sicherstellen.
    it('bevorzugt userId vor sub wenn beide vorhanden sind', async () => {
      mockFetchOk({ userId: 'richtig', sub: 'falsch', name: 'Test' });
      const req = makeReq({ authorization: 'Bearer x' });
      await authMiddleware(req, makeRes(), jest.fn() as NextFunction);
      expect(req.user?.id).toBe('richtig');
    });
  });

  describe('Adapter — Härtung (M12-Vorbereitung)', () => {
    beforeEach(() => {
      process.env.AUTH_SERVICE_URL = 'http://projekt1/auth/validate';
    });

    it('löst einen verschachtelten Nutzer ({ user: {...} }) auf', async () => {
      mockFetchOk({ user: { sub: 'u-nested', displayName: 'Nested User' } });
      const req = makeReq({ authorization: 'Bearer x' });
      await authMiddleware(req, makeRes(), jest.fn() as NextFunction);
      expect(req.user).toEqual({ id: 'u-nested', name: 'Nested User' });
    });

    it('lehnt ab (401) wenn die Antwort valid:false meldet (trotz HTTP 200)', async () => {
      mockFetchOk({ valid: false, userId: 'egal' });
      const res  = makeRes();
      const next = jest.fn() as NextFunction;
      await authMiddleware(makeReq({ authorization: 'Bearer x' }), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('lehnt ab (401) wenn keine Identität auflösbar ist (leere Antwort)', async () => {
      mockFetchOk({});
      const res  = makeRes();
      const next = jest.fn() as NextFunction;
      await authMiddleware(makeReq({ authorization: 'Bearer x' }), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('respektiert AUTH_FIELD_ID / AUTH_FIELD_NAME als Feldnamen-Override', async () => {
      process.env.AUTH_FIELD_ID = 'uuid';
      process.env.AUTH_FIELD_NAME = 'fullName';
      mockFetchOk({ uuid: 'u-override', fullName: 'Override Name' });
      const req = makeReq({ authorization: 'Bearer x' });
      await authMiddleware(req, makeRes(), jest.fn() as NextFunction);
      expect(req.user).toEqual({ id: 'u-override', name: 'Override Name' });
    });
  });

});
