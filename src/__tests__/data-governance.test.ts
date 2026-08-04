// M21 — Aufbewahrung & DSGVO-Anonymisierung (Service).
// DB wird gemockt; Transaktion über db.connect() teilt sich denselben Query-Mock (wie sessions.test.ts).
import { db } from '../config/db';
import { pruneInactiveSessions, anonymizeUser } from '../services/dataGovernance/dataGovernance.service';

jest.mock('../config/db', () => {
  const mockQuery = jest.fn();
  return {
    db: {
      query: mockQuery,
      connect: jest.fn().mockImplementation(() => Promise.resolve({ query: mockQuery, release: jest.fn() })),
    },
  };
});

beforeEach(() => {
  (db.query as jest.Mock).mockReset();
});

describe('M21 — Aufbewahrung (pruneInactiveSessions)', () => {
  it('löscht inaktive Sessions und gibt die Anzahl zurück', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rowCount: 3 });

    const deleted = await pruneInactiveSessions(6);

    expect(deleted).toBe(3);
    const [sql, params] = (db.query as jest.Mock).mock.calls[0];
    expect(sql).toContain('DELETE FROM sessions');
    expect(sql).toContain('documents'); // Aktivität über documents.updated_at
    expect(params).toEqual([6]);
  });

  it('lehnt eine nicht-positive Frist ab (ohne DB-Zugriff)', async () => {
    await expect(pruneInactiveSessions(0)).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('M21 — DSGVO-Anonymisierung (anonymizeUser)', () => {
  it('anonymisiert alle Tabellen atomar und liefert die Trefferzahlen', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({})                 // BEGIN
      .mockResolvedValueOnce({ rowCount: 1 })    // sessions.created_by
      .mockResolvedValueOnce({ rowCount: 2 })    // comments.author_id
      .mockResolvedValueOnce({ rowCount: 0 })    // comments.resolved_by
      .mockResolvedValueOnce({ rowCount: 1 })    // reviews.requester_id
      .mockResolvedValueOnce({ rowCount: 1 })    // review_feedback.author_id
      .mockResolvedValueOnce({ rowCount: 2 })    // review_assignees DELETE
      .mockResolvedValueOnce({ rowCount: 3 })    // history.author_id
      .mockResolvedValueOnce({ rowCount: 4 })    // notifications DELETE
      .mockResolvedValueOnce({ rowCount: 2 })    // session_views DELETE
      .mockResolvedValueOnce({ rowCount: 1 })    // session_members DELETE (N1)
      .mockResolvedValueOnce({ rowCount: 5 })    // change_log UPDATE (Punkt 3)
      .mockResolvedValueOnce({ rowCount: 7 })    // chat_messages UPDATE (C5)
      .mockResolvedValueOnce({ rowCount: 3 })    // session_tasks created_by UPDATE (H7)
      .mockResolvedValueOnce({ rowCount: 1 })    // session_tasks assignee_user_id UPDATE (H7)
      .mockResolvedValueOnce({ rowCount: 2 })    // session_drafts DELETE
      .mockResolvedValueOnce({});                // COMMIT

    const result = await anonymizeUser('user-x');

    expect(result).toEqual({
      sessions: 1, comments: 2, comments_resolved: 0,
      reviews_requester: 1, review_feedback: 1, history: 3,
      notifications_deleted: 4, session_views_deleted: 2,
      session_members_deleted: 1,
      change_log: 5,
      chat_messages: 7,
      session_tasks_created: 3, session_tasks_assigned: 1,
      drafts_deleted: 2,
    });
    // Transaktion korrekt geklammert
    expect((db.query as jest.Mock).mock.calls[0][0]).toBe('BEGIN');
    expect(db.query).toHaveBeenCalledWith('COMMIT');
    // Platzhalter wird verwendet (nicht die echte ID belassen)
    const sessionUpdate = (db.query as jest.Mock).mock.calls[1];
    expect(sessionUpdate[1]).toEqual(['user-x', 'deleted-user']);
  });

  it('macht bei einem Fehler einen ROLLBACK und wirft', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({})                       // BEGIN
      .mockRejectedValueOnce(new Error('DB kaputt'))   // erstes UPDATE schlägt fehl
      .mockResolvedValueOnce({});                      // ROLLBACK

    await expect(anonymizeUser('user-x')).rejects.toThrow('DB kaputt');
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('lehnt leere userId / den Platzhalter ab', async () => {
    await expect(anonymizeUser('')).rejects.toThrow();
    await expect(anonymizeUser('deleted-user')).rejects.toThrow();
  });
});
