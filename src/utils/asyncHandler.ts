// Wrappt eine async-Route, sodass abgelehnte Promises automatisch an next() (Error-Handler)
// gehen — ersetzt das wiederholte `try { … } catch (err) { next(err) }`.
// NICHT für Routen verwenden, die Fehler bewusst schlucken (best-effort-Persistenz).
import { RequestHandler } from 'express';

export const asyncHandler = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
