// Zentraler Error-Handler: fängt alle Fehler ab die in Routen mit next(err) weitergegeben werden.
// Registriert als letztes in app.ts — Express erkennt Error-Handler an den genau 4 Parametern.
import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

// AppError erweitert den Standard-JavaScript-Error um einen HTTP-Statuscode.
// Services können damit gezielte Fehler werfen:
//   throw Object.assign(new Error('Nicht gefunden'), { statusCode: 404 })
// Ohne statusCode fällt der Handler auf 500 (Interner Serverfehler) zurück.
export interface AppError extends Error { statusCode?: number; }

// Express erkennt diese Funktion als Error-Handler weil sie genau 4 Parameter hat (err, req, res, next).
// _req und _next werden nicht gebraucht, müssen aber deklariert werden damit Express die Signatur erkennt.
export const errorHandler = (err: AppError, _req: Request, res: Response, _next: NextFunction): void => {
  const statusCode = err.statusCode ?? 500;

  // Fehler strukturiert loggen — Pino serialisiert err.stack automatisch.
  logger.error({ err, statusCode }, '[ErrorHandler]');

  // QUAL-6: Bei 500ern niemals interne Details (DB-Fehlermeldungen, Stack-Traces) an den Client.
  // Nur bekannte App-Fehler (statusCode gesetzt) dürfen ihre Meldung weitergeben.
  const message = statusCode === 500
    ? 'Interner Serverfehler'
    : (err.message ?? 'Interner Serverfehler');

  // Einheitliches JSON-Format für ALLE Fehler im System.
  res.status(statusCode).json({ error: { message, status: statusCode } });
};
