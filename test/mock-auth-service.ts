/**
 * Mock-Auth-Service — simuliert den Token-Validierungs-Endpoint von Projekt 1 (M12).
 *
 * Zweck: M12/M17/M18 schon JETZT mit mehreren *unterschiedlichen* Nutzern end-to-end testen,
 *        bevor Projekt 1 die echte AUTH_SERVICE_URL liefert. Wenn die echte URL kommt,
 *        wird nur AUTH_SERVICE_URL umgestellt — am Anwendungscode ändert sich nichts.
 *
 * Start:  npm run mock:auth                 (Standard-Port 4000, überschreibbar via MOCK_AUTH_PORT)
 * Nutzen: in .env  AUTH_SERVICE_URL=http://localhost:4000/validate  setzen, dann Server starten.
 *
 * Vertrag (bewusst so wie der echte erwartete):
 *   POST <url>   Body { "token": "<t>" }   ODER   Header "Authorization: Bearer <t>"
 *     → 200 { "userId": "...", "name": "..." }   bei gültigem Token
 *     → 401                                       bei fehlendem/ungültigem Token
 *
 * Feste Test-Nutzer (Token → Nutzer). Die User-IDs entsprechen bewusst den Seed-Nutzern
 * (db/seed-roles.sql), damit dieselben Test-Sessions in Dev- UND Mock-Modus funktionieren:
 *   alice → alice (Alice Albrecht) | bob → bob (Bob Bauer) | carol → carol (Carol Conrad)
 *   dave  → dave  (Dave Dietrich)  | erin → erin (Erin Engel)
 *   jeder andere nicht-leere Token → eigener Nutzer { id: "<token>", name: "<token>" }
 *   "" (leer) | "invalid" | "expired" → 401 (zum Testen der Ablehnung)
 */
import { createServer } from 'http';

const PORT = Number(process.env.MOCK_AUTH_PORT ?? 4000);

// 5 feste Testnutzer — bewusst unterscheidbare IDs + Anzeigenamen, um gerichtete Funktionen
// (Benachrichtigungen, @-Erwähnungen, Review-Anfrager/Reviewer, Ownership) durchzuspielen.
const KNOWN: Record<string, { userId: string; name: string }> = {
  alice: { userId: 'alice', name: 'Alice Albrecht' },
  bob:   { userId: 'bob',   name: 'Bob Bauer' },
  carol: { userId: 'carol', name: 'Carol Conrad' },
  dave:  { userId: 'dave',  name: 'Dave Dietrich' },
  erin:  { userId: 'erin',  name: 'Erin Engel' },
};
const INVALID = new Set(['', 'invalid', 'expired']);

function resolveUser(token: string): { userId: string; name: string } | null {
  if (INVALID.has(token)) return null;
  if (KNOWN[token]) return KNOWN[token];
  return { userId: token, name: token }; // jeder andere Token = eigener Nutzer (Token == User-ID, passt zum Seed)
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let token = '';
    try {
      token = (JSON.parse(body || '{}') as { token?: string }).token ?? '';
    } catch {
      /* kein/ungültiges JSON — gleich Bearer-Header versuchen */
    }
    const authHeader = req.headers.authorization;
    if (!token && authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);

    const user = resolveUser(token);
    if (!user) {
      console.log(`[mock-auth] 401  token="${token}"`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    console.log(`[mock-auth] 200  token="${token}" → ${user.userId} (${user.name})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(user));
  });
});

server.listen(PORT, () => {
  console.log(`[mock-auth] läuft auf http://localhost:${PORT}`);
  console.log(`[mock-auth] → in .env setzen: AUTH_SERVICE_URL=http://localhost:${PORT}/validate`);
  console.log('[mock-auth] Test-Nutzer: alice · bob · carol · dave · erin  (+ beliebiger Token = eigener Nutzer; leer|invalid|expired → 401)');
});
