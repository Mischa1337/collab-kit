import pino from 'pino';

// Entwicklung: lesbare Ausgabe mit pino-pretty
// Produktion:  reines JSON (von Log-Tools direkt verarbeitbar)
// pino-pretty ist eine devDependency — im Prod-Image (npm ci --omit=dev) fehlt sie.
// Wird das Prod-Image mit NODE_ENV=development gefahren (Docker-Compose), darf das
// NICHT crashen → nur dann pretty-Transport nutzen, wenn pino-pretty auflösbar ist.
function prettyAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV !== 'production' && prettyAvailable() && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  }),
});
