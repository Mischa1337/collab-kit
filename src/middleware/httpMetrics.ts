import { Request, Response, NextFunction } from 'express';
import { httpDuration } from '../services/health/routes';

export const httpMetrics = (req: Request, res: Response, next: NextFunction): void => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    end({
      method: req.method,
      route: req.route?.path ?? req.path,
      status: String(res.statusCode),
    });
  });
  next();
};
