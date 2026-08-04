// N1 (Erweiterung) — abgestufte Rollen: Rechte-Helfer, getSessionRole, requireRole.
// WICHTIG: AUTH_SERVICE_URL wird je Test gesetzt/zurückgesetzt (jest --runInBand teilt process.env).
jest.mock('../config/db', () => ({ db: { query: jest.fn() }, connectDB: jest.fn() }));

import { db } from '../config/db';
import {
  canEditModel, canComment, canReview, canSeeComments, canSeeInternal, getSessionRole, requireRole,
} from '../middleware/authorization';

const mockQuery = db.query as jest.Mock;
const ORIG = process.env.AUTH_SERVICE_URL;
afterEach(() => {
  if (ORIG === undefined) delete process.env.AUTH_SERVICE_URL;
  else process.env.AUTH_SERVICE_URL = ORIG;
  jest.clearAllMocks();
});

describe('Rechte-Helfer (Berechtigungsmatrix)', () => {
  it('canEditModel nur für owner/member', () => {
    expect(canEditModel('owner')).toBe(true);
    expect(canEditModel('member')).toBe(true);
    expect(canEditModel('commentator')).toBe(false);
    expect(canEditModel('spectator')).toBe(false);
    expect(canEditModel(null)).toBe(false);
  });
  it('canComment für owner/member/commentator, nicht spectator', () => {
    expect(canComment('owner')).toBe(true);
    expect(canComment('member')).toBe(true);
    expect(canComment('commentator')).toBe(true);
    expect(canComment('spectator')).toBe(false);
    expect(canComment(null)).toBe(false);
  });
  it('canReview (Peer Review) nur für owner/member', () => {
    expect(canReview('owner')).toBe(true);
    expect(canReview('member')).toBe(true);
    expect(canReview('commentator')).toBe(false);
    expect(canReview('spectator')).toBe(false);
    expect(canReview(null)).toBe(false);
  });
  it('canSeeComments für owner/member/commentator, nicht spectator', () => {
    expect(canSeeComments('owner')).toBe(true);
    expect(canSeeComments('commentator')).toBe(true);
    expect(canSeeComments('spectator')).toBe(false);
  });
  it('canSeeInternal nur für das Team (owner/member) — commentator/spectator NICHT', () => {
    expect(canSeeInternal('owner')).toBe(true);
    expect(canSeeInternal('member')).toBe(true);
    expect(canSeeInternal('commentator')).toBe(false); // Dozent sieht interne Kommentare nicht
    expect(canSeeInternal('spectator')).toBe(false);
    expect(canSeeInternal(null)).toBe(false);
  });
});

describe('getSessionRole', () => {
  it('Dev-Modus (kein AUTH_SERVICE_URL): owner, ohne DB-Abfrage', async () => {
    delete process.env.AUTH_SERVICE_URL;
    await expect(getSessionRole('u1', 's1')).resolves.toBe('owner');
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it('Prod: liefert die Rolle aus der DB', async () => {
    process.env.AUTH_SERVICE_URL = 'http://auth';
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'spectator' }] });
    await expect(getSessionRole('u1', 's1')).resolves.toBe('spectator');
  });
  it('Prod: kein Mitglied → null', async () => {
    process.env.AUTH_SERVICE_URL = 'http://auth';
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getSessionRole('u1', 's1')).resolves.toBeNull();
  });
});

describe('requireRole', () => {
  const run = async (mw: ReturnType<typeof requireRole>, userRole: string | null) => {
    if (process.env.AUTH_SERVICE_URL && userRole) mockQuery.mockResolvedValueOnce({ rows: [{ role: userRole }] });
    else if (process.env.AUTH_SERVICE_URL) mockQuery.mockResolvedValueOnce({ rows: [] });
    const req = { user: { id: 'u1' }, params: { id: 's1' } } as never;
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ json }) } as never;
    const next = jest.fn();
    await mw(req, res, next);
    return { next, status: (res as { status: jest.Mock }).status, json };
  };

  it('Dev-Modus: lässt immer durch', async () => {
    delete process.env.AUTH_SERVICE_URL;
    const { next, status } = await run(requireRole('owner'), 'spectator');
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
  it('Prod: erlaubte Rolle → next', async () => {
    process.env.AUTH_SERVICE_URL = 'http://auth';
    const { next } = await run(requireRole('owner', 'member', 'commentator'), 'commentator');
    expect(next).toHaveBeenCalled();
  });
  it('Prod: spectator darf kein Feedback → 403', async () => {
    process.env.AUTH_SERVICE_URL = 'http://auth';
    const { next, status, json } = await run(requireRole('owner', 'member', 'commentator'), 'spectator');
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ status: 403 }) }));
  });
  it('Prod: Nicht-Mitglied → 403', async () => {
    process.env.AUTH_SERVICE_URL = 'http://auth';
    const { next, status } = await run(requireRole('owner'), null);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});
