// M3 — API Gateway Tests
// Prüft die grundlegende Infrastruktur: Health-Check, 404-Handling, CORS und Auth-Middleware.
// Kein Docker nötig — supertest startet die Express-App direkt im Speicher.
import request from 'supertest';
import { app } from '../app';

describe('M3 — API Gateway', () => {

  describe('GET /health', () => {
    // Monitoring-Tools und Docker health checks rufen diesen Endpunkt auf — er muss immer 200 zurückgeben.
    it('antwortet mit Status 200', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });

    // Der Body muss exakt { status: 'ok' } enthalten, damit Monitoring-Tools ihn parsen können.
    it('gibt status: ok zurück', async () => {
      const res = await request(app).get('/health');
      expect(res.body.status).toBe('ok');
    });
  });

  describe('404 Handler', () => {
    // Unbekannte Routen dürfen nicht abstürzen, sondern müssen sauber mit 404 antworten.
    it('gibt 404 für unbekannte Route zurück', async () => {
      const res = await request(app).get('/irgendwas');
      expect(res.status).toBe(404);
    });

    // Frontend erwartet JSON — kein HTML-Fehlerblock der im JavaScript abstürzt.
    it('antwortet mit JSON, nicht HTML', async () => {
      const res = await request(app).get('/irgendwas');
      expect(res.body.error.status).toBe(404);
    });
  });

  describe('CORS', () => {
    // Ohne diesen Header blockiert der Browser alle API-Anfragen aus dem Frontend (andere Domain/Port).
    it('setzt Access-Control-Allow-Origin Header', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('Auth-Middleware', () => {
    // Ohne AUTH_SERVICE_URL (Test-/Entwicklungsumgebung): Fallback-Nutzer aktiv, kein 401.
    // Mit AUTH_SERVICE_URL (Produktion): Bearer-Token erforderlich, sonst 401.
    it('lässt Anfragen ohne Token durch wenn AUTH_SERVICE_URL nicht gesetzt ist', async () => {
      const res = await request(app).get('/api/sessions');
      expect(res.status).not.toBe(401);
    });
  });

});
