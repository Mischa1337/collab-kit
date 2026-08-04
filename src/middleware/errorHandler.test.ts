import { Request, Response, NextFunction } from 'express';
import { errorHandler, AppError } from './errorHandler';

describe('errorHandler', () => {
  const mockRes = () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    return { res: { status } as unknown as Response, json, status };
  };

  it('verwendet statusCode aus dem Fehler', () => {
    const { res, status, json } = mockRes();
    const err: AppError = Object.assign(new Error('Ungültige Eingabe'), { statusCode: 400 });
    errorHandler(err, {} as Request, res, jest.fn() as unknown as NextFunction);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: { message: 'Ungültige Eingabe', status: 400 } });
  });

  it('fällt auf 500 zurück wenn kein statusCode gesetzt', () => {
    const { res, status } = mockRes();
    const err = new Error('Unbekannter Fehler');
    errorHandler(err, {} as Request, res, jest.fn() as unknown as NextFunction);
    expect(status).toHaveBeenCalledWith(500);
  });

  it('verwendet statusCode 401 für nicht autorisierte Fehler', () => {
    const { res, status, json } = mockRes();
    const err: AppError = Object.assign(new Error('Nicht autorisiert'), { statusCode: 401 });
    errorHandler(err, {} as Request, res, jest.fn() as unknown as NextFunction);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { message: 'Nicht autorisiert', status: 401 } });
  });
});
