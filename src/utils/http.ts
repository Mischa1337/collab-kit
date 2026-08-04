// HTTP-Helfer — einheitliche Fehler-Antworten an EINER Stelle.
// Format IDENTISCH zu errorHandler.ts: { error: { message, status } } (FE-Vertrag).
import { Response } from 'express';
import { isUuid } from './validation';

// Schreibt eine Fehlerantwort im Standardformat. Ersetzt die vielen Inline-
// `res.status(x).json({ error: { message, status: x } })`-Wiederholungen.
export function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message, status } });
}

// Validiert ein Pflicht-/Body-Feld als UUID. Bei Fehler 400 + false, sonst true.
// Type-Guard, damit der Aufrufer value danach als string nutzen kann.
export function assertUuid(res: Response, value: unknown, field: string): value is string {
  if (isUuid(value)) return true;
  sendError(res, 400, `${field} muss eine gültige UUID sein`);
  return false;
}
