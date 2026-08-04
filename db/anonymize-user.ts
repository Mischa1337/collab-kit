// M21 — DSGVO „Recht auf Löschung" (Art. 17), CLI: anonymisiert die personenbezogenen
// Daten eines Nutzers projektweit (statt hart löschen → Threads/History bleiben konsistent).
// Aufruf:  npm run anonymize-user -- <userId>
import 'dotenv/config';
import { anonymizeUser } from '../src/services/dataGovernance/dataGovernance.service';
import { db } from '../src/config/db';
import { logger } from '../src/config/logger';

const userId = process.argv[2];
if (!userId) {
  console.error('Usage: npm run anonymize-user -- <userId>');
  process.exit(1);
}

anonymizeUser(userId)
  .then((result) => logger.info({ userId, ...result }, '[DSGVO] Anonymisierung abgeschlossen'))
  .catch((err) => { logger.error({ err }, '[DSGVO] Anonymisierung fehlgeschlagen'); process.exitCode = 1; })
  .finally(() => db.end());
