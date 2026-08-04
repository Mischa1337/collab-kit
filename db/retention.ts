// M21 — Aufbewahrungsjob (CLI/Cron): löscht inaktive Sessions älter als die Frist.
// Aufruf:  npm run retention            (Frist aus RETENTION_MONTHS, Standard 6)
//          npm run retention -- 12      (Frist in Monaten als Argument)
import 'dotenv/config';
import { pruneInactiveSessions, pruneOldChangeLog } from '../src/services/dataGovernance/dataGovernance.service';
import { db } from '../src/config/db';
import { logger } from '../src/config/logger';

const months = Number(process.argv[2] ?? process.env.RETENTION_MONTHS ?? 6);
const changeLogDays = Number(process.env.CHANGELOG_RETENTION_DAYS ?? 90);

(async () => {
  try {
    const sessions = await pruneInactiveSessions(months);
    logger.info(`[Retention] ${sessions} inaktive Session(s) gelöscht (älter als ${months} Monate).`);
    const changes = await pruneOldChangeLog(changeLogDays);
    logger.info(`[Retention] ${changes} change_log-Eintrag/-Einträge gelöscht (älter als ${changeLogDays} Tage).`);
  } catch (err) {
    logger.error({ err }, '[Retention] fehlgeschlagen');
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
