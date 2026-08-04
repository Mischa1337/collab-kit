// Middleware-Fabrik: prüft, dass ein Pfad-Parameter eine gültige UUID ist, sonst 400.
// Ersetzt wiederholte Inline-Checks `if (!UUID_REGEX.test(req.params.x)) …` in den Routen.
import { RequestHandler } from 'express';
import { isUuid } from '../utils/validation';
import { sendError } from '../utils/http';

export const requireUuidParam = (name: string): RequestHandler => (req, res, next) => {
  if (isUuid(req.params[name])) { next(); return; }
  sendError(res, 400, `${name} muss eine gültige UUID sein`);
};
